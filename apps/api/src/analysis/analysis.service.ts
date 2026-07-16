import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ACTIVE_JOB_STATUSES,
  ANALYSIS_DEPTHS,
  type AnalysisJob,
  type AnalysisOptions,
  type AnalysisReport,
  type ConversationMessage,
  type JobStatus,
  type ModelCapability,
  type ModelConfig,
  type ReportChapter,
  type ReportPoint,
  type ReportScreenshot,
  type VideoInfo,
  type VideoPart,
} from '../common/domain';
import { assertPlainObject } from '../common/http-error';
import { ModelConfigsService } from '../model-configs/model-configs.service';
import { OpenAiCompatibleClient } from '../model-configs/openai-compatible.client';
import { StorageService } from '../storage/storage.service';

interface CreateJobDto {
  video: VideoInfo;
  options: AnalysisOptions;
}

interface BilibiliViewResponse {
  code: number;
  message: string;
  data?: {
    bvid: string;
    title: string;
    pic: string;
    pubdate: number;
    duration: number;
    desc: string;
    owner: { name: string };
    pages: Array<{ cid: number; page: number; part: string; duration: number }>;
  };
}

interface BilibiliPlayUrlResponse {
  code: number;
  message: string;
  data?: {
    dash?: {
      audio?: Array<{
        baseUrl?: string;
        base_url?: string;
        backupUrl?: string[];
        backup_url?: string[];
        bandwidth?: number;
      }>;
      video?: Array<{
        baseUrl?: string;
        base_url?: string;
        backupUrl?: string[];
        backup_url?: string[];
        bandwidth?: number;
        codecs?: string;
        id?: number;
      }>;
    };
  };
}

interface SubtitleItem {
  from?: number;
  to?: number;
  content?: string;
}

interface DownloadedAudio {
  bytes: Buffer;
  fileName: string;
}

interface DownloadedVideo {
  filePath: string;
  fileName: string;
}

interface FrameEvidence {
  partPage: number;
  partTitle: string;
  timestampSeconds: number;
  localSeconds: number;
  filePath: string;
  publicUrl: string;
  description: string;
}

interface ExtractiveReportDraft {
  summary: string;
  overview: string;
  chapters: ReportChapter[];
  keyPoints: ReportPoint[];
  facts: string[];
  conclusion: string;
}

interface RankedSentence {
  index: number;
  text: string;
  score: number;
}

type TranscriptSource = 'none' | 'subtitle' | 'asr';

class JobCancelledError extends Error {}

@Injectable()
export class AnalysisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly jobsFile = 'analysis-jobs.json';
  private readonly reportsFile = 'analysis-reports.json';
  private readonly jobs = new Map<string, AnalysisJob>();
  private readonly reports = new Map<string, AnalysisReport>();
  private readonly cancelRequested = new Set<string>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly client: OpenAiCompatibleClient,
    private readonly modelConfigs: ModelConfigsService,
    private readonly storage: StorageService,
  ) {}

  async onModuleInit() {
    const jobs = await this.storage.readJson<AnalysisJob[]>(this.jobsFile, []);
    const reports = await this.storage.readJson<AnalysisReport[]>(this.reportsFile, []);

    for (const job of jobs) {
      if (ACTIVE_JOB_STATUSES.includes(job.status)) {
        job.status = 'failed';
        job.errorMessage = '服务重启后任务已中断，请重新创建分析任务。';
        job.currentStage = '任务已中断。';
        job.completedAt = new Date().toISOString();
      }
      if (job.status === 'failed' && job.errorMessage) {
        job.errorMessage = this.normalizeStoredFailure(job.errorMessage);
      }
      if (job.status === 'failed' && job.errorMessage && job.currentStage.startsWith('任务执行失败')) {
        job.currentStage = `任务执行失败：${this.truncateText(job.errorMessage, 80)}`;
      }
      this.jobs.set(job.id, job);
    }
    for (const report of reports) this.reports.set(report.id, report);
    await this.persistJobs();

    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredRuntimeData();
    }, 60 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async getVideoInfo(bvid: string): Promise<VideoInfo> {
    if (!/^BV[0-9A-Za-z]{10}$/i.test(bvid)) {
      throw new BadRequestException({ message: '请输入合法的 BV 号。' });
    }

    const normalizedBvid = bvid.trim();
    const referer = `https://www.bilibili.com/video/${normalizedBvid}/`;
    const response = await this.fetchJson<BilibiliViewResponse>(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(normalizedBvid)}`,
      10000,
      referer,
    );

    if (response.code !== 0 || !response.data) {
      throw new BadRequestException({ message: response.message || '未能读取该视频的信息。' });
    }

    const data = response.data;
    return {
      bvid: data.bvid,
      url: `https://www.bilibili.com/video/${data.bvid}`,
      title: data.title,
      coverUrl: data.pic.replace(/^http:/, 'https:'),
      ownerName: data.owner.name,
      publishedAt: new Date(data.pubdate * 1000).toLocaleString('zh-CN', { hour12: false }),
      duration: data.duration,
      description: data.desc,
      isPublic: true,
      parts: data.pages.map((part) => ({
        cid: part.cid,
        page: part.page,
        title: part.part,
        duration: part.duration,
      })),
    };
  }

  async createJob(payload: unknown): Promise<AnalysisJob> {
    const dto = await this.validateCreatePayload(payload);
    const now = new Date().toISOString();
    const job: AnalysisJob = {
      id: randomUUID(),
      bvid: dto.video.bvid,
      video: dto.video,
      options: dto.options,
      status: 'waiting',
      progress: 0,
      currentStage: '等待处理。',
      createdAt: now,
    };

    this.jobs.set(job.id, job);
    await this.persistJobs();
    this.logger.log(`Analysis job created: ${job.id}`);
    setTimeout(() => {
      void this.runJob(job.id);
    }, 0);
    return job;
  }

  listJobs(): AnalysisJob[] {
    return [...this.jobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getJob(id: string): AnalysisJob {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException({ message: '任务不存在。' });
    return job;
  }

  async cancelJob(id: string): Promise<AnalysisJob> {
    const job = this.getJob(id);
    if (!ACTIVE_JOB_STATUSES.includes(job.status)) return job;

    this.cancelRequested.add(id);
    job.status = 'cancelled';
    job.currentStage = '任务已取消。';
    job.completedAt = new Date().toISOString();
    await this.persistJobs();
    this.logger.log(`Analysis job cancelled: ${job.id}`);
    return job;
  }

  async deleteJob(id: string): Promise<void> {
    const job = this.getJob(id);
    this.jobs.delete(id);
    if (job.reportId) this.reports.delete(job.reportId);
    await Promise.all([
      this.persistJobs(),
      this.persistReports(),
      this.cleanupJobRuntimeData(id),
      this.cleanupJobReportAssets(id),
    ]);
  }

  getReport(id: string): AnalysisReport {
    const report = this.reports.get(id);
    if (!report) throw new NotFoundException({ message: '报告不存在。' });
    return report;
  }

  async getRuntimeAsset(jobId: string, fileName: string): Promise<{ filePath: string; mimeType: string }> {
    if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^[A-Za-z0-9_.-]+$/.test(fileName)) {
      throw new NotFoundException({ message: '资源不存在。' });
    }

    const framesDir = this.jobFramesDir(jobId);
    const filePath = resolve(framesDir, basename(fileName));
    if (!this.isPathInside(framesDir, filePath)) {
      throw new NotFoundException({ message: '资源不存在。' });
    }

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error('not a file');
    } catch {
      throw new NotFoundException({ message: '资源不存在。' });
    }

    const extension = extname(fileName).toLowerCase();
    return {
      filePath,
      mimeType: extension === '.png' ? 'image/png' : 'image/jpeg',
    };
  }

  async answerQuestion(reportId: string, payload: unknown): Promise<ConversationMessage> {
    const report = this.getReport(reportId);
    assertPlainObject(payload, '问题不能为空。');
    const question = typeof payload.question === 'string' ? payload.question.trim() : '';
    if (!question) throw new BadRequestException({ message: '问题不能为空。' });
    if (question.length > 1000) throw new BadRequestException({ message: '问题长度不能超过 1000 个字符。' });

    const job = this.jobs.get(report.jobId);
    let text: string | undefined;
    const modelId = job?.options.modelProfileIds.text ?? job?.options.modelProfileIds.video;
    if (modelId) {
      try {
        const { config, apiKey } = await this.modelConfigs.getConfigWithApiKey(modelId);
        text = await this.client.chat(
          config,
          apiKey,
          [
            {
              role: 'system',
              content:
                '你是本地视频分析报告问答助手。只能依据给定报告回答；报告没有的信息要明确说明无法从当前视频确认。不要透露模型配置、密钥、服务端路径或内部错误。',
            },
            {
              role: 'user',
              content: `报告 JSON：\n${JSON.stringify(report)}\n\n用户问题：${question}`,
            },
          ],
          { temperature: 0.2, maxTokens: 800 },
        );
      } catch {
        text = undefined;
      }
    }

    return {
      id: randomUUID(),
      role: 'assistant',
      text: text?.trim() || this.fallbackAnswer(report, question),
      createdAt: new Date().toISOString(),
    };
  }

  private async runJob(id: string): Promise<void> {
    let transcript = '';
    let transcriptSource: TranscriptSource = 'none';
    let visualEvidence: FrameEvidence[] = [];
    let completedSuccessfully = false;
    try {
      const job = this.getJob(id);
      await this.advance(id, 'fetching_video', 8, `正在确认 ${job.bvid} 的视频信息。`);

      await this.advance(id, 'fetching_subtitle', 18, '正在尝试读取 Bilibili 公开字幕。');
      transcript = await this.fetchPublicSubtitles(job);
      if (transcript) transcriptSource = 'subtitle';

      if (job.options.mode === 'subtitle' && !transcript) {
        await this.advance(id, 'extracting_audio', 34, '未找到公开字幕，正在准备音频转写链路。');
        await this.advance(id, 'transcribing', 52, '正在调用 ASR 模型转写音频。');
        transcript = await this.transcribeSelectedParts(this.getJob(id));
        transcriptSource = 'asr';
      }

      if (job.options.mode === 'multimodal') {
        if (!transcript) {
          await this.advance(id, 'extracting_audio', 34, '未找到公开字幕，正在准备音频转写链路。');
          await this.advance(id, 'transcribing', 52, '正在调用 ASR 模型转写音频。');
          transcript = await this.transcribeSelectedParts(this.getJob(id));
          transcriptSource = 'asr';
        } else {
          await this.advance(id, 'extracting_audio', 34, '已取得公开字幕，正在整理音频和字幕上下文。');
        }
      }

      if (job.options.generateScreenshots) {
        await this.advance(id, 'extracting_frames', 68, '正在提取关键画面并整理截图上下文。');
        visualEvidence = await this.prepareVisualEvidence(this.getJob(id));
      }

      await this.advance(id, 'analyzing', 82, '正在调用模型生成结构化分析。');
      const report = await this.generateReport(this.getJob(id), transcript, transcriptSource, visualEvidence);

      await this.advance(id, 'generating_report', 94, '正在保存结构化报告。');
      this.reports.set(report.id, report);
      await this.persistReports();

      const completed = this.getJob(id);
      this.ensureActive(completed);
      completed.status = 'completed';
      completed.progress = 100;
      completed.currentStage = '分析完成，报告已生成。';
      completed.completedAt = new Date().toISOString();
      completed.reportId = report.id;
      await this.persistJobs();
      completedSuccessfully = true;
      this.logger.log(`Analysis job completed: ${id}`);
    } catch (error) {
      if (error instanceof JobCancelledError) return;
      const job = this.jobs.get(id);
      if (!job || job.status === 'cancelled') return;
      job.status = 'failed';
      job.errorMessage = this.readableFailure(error);
      job.currentStage = `任务执行失败：${this.truncateText(job.errorMessage, 80)}`;
      job.completedAt = new Date().toISOString();
      await this.persistJobs();
      this.logger.warn(`Analysis job failed: ${id}`);
    } finally {
      if (!completedSuccessfully) {
        await this.cleanupJobRuntimeData(id);
      }
      this.cancelRequested.delete(id);
    }
  }

  private async advance(
    id: string,
    status: JobStatus,
    progress: number,
    currentStage: string,
  ): Promise<void> {
    const job = this.getJob(id);
    this.ensureActive(job);
    job.status = status;
    job.progress = progress;
    job.currentStage = currentStage;
    await this.persistJobs();
    await this.sleep(Number(process.env.BVA_STAGE_DELAY_MS ?? 900));
    this.ensureActive(this.getJob(id));
  }

  private ensureActive(job: AnalysisJob): void {
    if (job.status === 'cancelled' || this.cancelRequested.has(job.id)) {
      throw new JobCancelledError();
    }
  }

  private async fetchPublicSubtitles(job: AnalysisJob): Promise<string> {
    const selected = job.video.parts.filter((part) => job.options.selectedPartCids.includes(part.cid));
    const chunks: string[] = [];
    for (const part of selected) {
      try {
        const player = await this.fetchJson<Record<string, unknown>>(
          `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(job.bvid)}&cid=${encodeURIComponent(String(part.cid))}`,
          8000,
          job.video.url,
        );
        const subtitles = (((player.data as Record<string, unknown> | undefined)?.subtitle as
          | Record<string, unknown>
          | undefined)?.subtitles ?? []) as Array<Record<string, unknown>>;
        const first = subtitles.find((item) => typeof item.subtitle_url === 'string');
        const rawUrl = first?.subtitle_url as string | undefined;
        if (!rawUrl) continue;
        const subtitleUrl = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
        const body = await this.fetchJson<{ body?: SubtitleItem[] }>(subtitleUrl, 8000, job.video.url);
        const text = (body.body ?? [])
          .map((item) => item.content?.trim())
          .filter(Boolean)
          .join('\n');
        if (text) chunks.push(`P${part.page} ${part.title}\n${text}`);
      } catch {
        // Public subtitles are best-effort. Missing or blocked subtitles fall back
        // to the ASR stage and report confidence notes.
      }
    }
    return chunks.join('\n\n').slice(0, 12000);
  }

  private async transcribeSelectedParts(job: AnalysisJob): Promise<string> {
    const asrProfileId = job.options.modelProfileIds.asr;
    if (!asrProfileId) throw new BadRequestException({ message: '缺少 ASR 模型配置。' });
    const { config, apiKey } = await this.modelConfigs.getConfigWithApiKey(asrProfileId, 'asr');
    const selected = job.video.parts.filter((part) => job.options.selectedPartCids.includes(part.cid));
    const chunks: string[] = [];

    for (const part of selected) {
      this.ensureActive(this.getJob(job.id));
      const audio = await this.downloadPartAudio(job, part);
      this.ensureActive(this.getJob(job.id));
      let text: string;
      try {
        text = await this.client.transcribe(config, apiKey, audio.bytes, audio.fileName);
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : 'ASR 模型转写失败。';
        throw new Error(`P${part.page} ASR 转写失败：${message}`);
      }
      if (text.trim()) chunks.push(`P${part.page} ${part.title}\n${text.trim()}`);
    }

    if (!chunks.length) throw new Error('未找到公开字幕，且 ASR 未返回有效转写内容。');
    return chunks.join('\n\n').slice(0, 12000);
  }

  private async downloadPartAudio(job: AnalysisJob, part: VideoPart): Promise<DownloadedAudio> {
    const playUrl = await this.fetchJson<BilibiliPlayUrlResponse>(
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(job.bvid)}&cid=${encodeURIComponent(String(part.cid))}&fnval=16&fourk=0`,
      8000,
      job.video.url,
    );
    if (playUrl.code !== 0) {
      throw new Error(playUrl.message || 'Bilibili 音频地址获取失败。');
    }

    const audioItems = playUrl.data?.dash?.audio ?? [];
    const audioUrl = audioItems
      .slice()
      .sort((a, b) => Number(b.bandwidth ?? 0) - Number(a.bandwidth ?? 0))
      .flatMap((item) => [
        item.baseUrl,
        item.base_url,
        ...(item.backupUrl ?? []),
        ...(item.backup_url ?? []),
      ])
      .find((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url));
    if (!audioUrl) throw new Error('未能获取该视频分 P 的公开音频流。');

    const bytes = await this.fetchBinary(audioUrl, this.maxAudioBytes(), job.video.url);
    return {
      bytes,
      fileName: `${job.bvid}-p${part.page}.m4a`,
    };
  }

  private async prepareVisualEvidence(job: AnalysisJob): Promise<FrameEvidence[]> {
    const maxFrames = Math.min(job.options.maxScreenshots, this.envNumber('BVA_MAX_FRAMES', 20, 0, 100));
    if (!job.options.generateScreenshots || maxFrames <= 0) return [];

    const imageProfileId = job.options.modelProfileIds.image;
    if (!imageProfileId) throw new BadRequestException({ message: '缺少图片理解模型配置。' });

    await mkdir(this.jobFramesDir(job.id), { recursive: true });
    await mkdir(this.jobVideosDir(job.id), { recursive: true });

    const selected = job.video.parts
      .filter((part) => job.options.selectedPartCids.includes(part.cid))
      .sort((a, b) => a.page - b.page);
    const frames: FrameEvidence[] = [];

    for (const part of selected) {
      this.ensureActive(this.getJob(job.id));
      if (frames.length >= maxFrames) break;
      const video = await this.downloadPartVideo(job, part);
      try {
        const extracted = await this.extractPartFrames(job, part, video, maxFrames - frames.length);
        frames.push(...extracted);
      } finally {
        await this.safeUnlink(video.filePath);
      }
    }

    if (!frames.length) throw new Error('未能从公开视频流中提取关键帧。');
    return this.describeFrames(job, frames);
  }

  private async downloadPartVideo(job: AnalysisJob, part: VideoPart): Promise<DownloadedVideo> {
    const playUrl = await this.fetchJson<BilibiliPlayUrlResponse>(
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(job.bvid)}&cid=${encodeURIComponent(String(part.cid))}&fnval=16&fourk=0`,
      8000,
      job.video.url,
    );
    if (playUrl.code !== 0) {
      throw new Error(playUrl.message || 'Bilibili 视频地址获取失败。');
    }

    const videoUrl = this.bestMediaUrl(playUrl.data?.dash?.video ?? []);
    if (!videoUrl) throw new Error('未能获取该视频分 P 的公开视频流。');

    const fileName = `${job.bvid}-p${part.page}-${part.cid}.mp4`;
    const filePath = join(this.jobVideosDir(job.id), fileName);
    await this.fetchToFile(videoUrl, filePath, this.maxVideoBytes(), job.video.url, '视频');
    return { filePath, fileName };
  }

  private async extractPartFrames(
    job: AnalysisJob,
    part: VideoPart,
    video: DownloadedVideo,
    remaining: number,
  ): Promise<FrameEvidence[]> {
    const targets = this.frameTargets(part, remaining);
    const frames: FrameEvidence[] = [];
    const partStart = this.partStartSeconds(job, part);

    for (let index = 0; index < targets.length; index += 1) {
      this.ensureActive(this.getJob(job.id));
      const localSeconds = targets[index];
      const timestampSeconds = Math.max(0, Math.round(partStart + localSeconds));
      const fileName = `p${part.page}-${String(index + 1).padStart(3, '0')}-${timestampSeconds}s.jpg`;
      const filePath = join(this.jobFramesDir(job.id), fileName);
      await this.runFfmpeg(
        [
          '-y',
          '-ss',
          localSeconds.toFixed(2),
          '-i',
          video.filePath,
          '-frames:v',
          '1',
          '-vf',
          'scale=720:-2',
          '-q:v',
          '4',
          filePath,
        ],
        `P${part.page} ${this.formatSeconds(timestampSeconds)} 关键帧抽取失败`,
      );
      frames.push({
        partPage: part.page,
        partTitle: part.title,
        timestampSeconds,
        localSeconds,
        filePath,
        publicUrl: this.publicFrameUrl(job.id, fileName),
        description: `P${part.page} ${this.formatSeconds(timestampSeconds)} 的关键帧。`,
      });
    }

    return frames;
  }

  private frameTargets(part: VideoPart, remaining: number): number[] {
    if (remaining <= 0) return [];
    const interval = this.envNumber('BVA_FRAME_INTERVAL_SECONDS', 30, 1, 3600);
    const desired = Math.max(1, Math.ceil(Math.max(part.duration, 1) / interval));
    const count = Math.min(remaining, desired);
    const lastUsableSecond = Math.max(part.duration - 0.5, 0);
    return Array.from({ length: count }, (_, index) => {
      const centered = ((index + 0.5) * Math.max(part.duration, 1)) / count;
      return Math.min(lastUsableSecond, Math.max(0, centered));
    });
  }

  private async describeFrames(job: AnalysisJob, frames: FrameEvidence[]): Promise<FrameEvidence[]> {
    const imageProfileId = job.options.modelProfileIds.image;
    if (!imageProfileId) throw new BadRequestException({ message: '缺少图片理解模型配置。' });
    const { config, apiKey } = await this.modelConfigs.getConfigWithApiKey(imageProfileId, 'image');
    const described: FrameEvidence[] = [];

    for (const frame of frames) {
      this.ensureActive(this.getJob(job.id));
      const imageUrl = await this.imageDataUrl(frame.filePath);
      let description: string;
      try {
        description = await this.client.chat(
          config,
          apiKey,
          [
            {
              role: 'system',
              content:
                '你是视频关键帧图片理解助手。只描述图中可见事实，包括场景、人物、界面、动作和屏幕文字；不要臆测视频上下文。',
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `请用${job.options.outputLanguage}概括这张关键帧，控制在 120 字以内。时间点：P${frame.partPage} ${this.formatSeconds(frame.timestampSeconds)}。`,
                },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
          { temperature: 0.1, maxTokens: 220 },
        );
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : '图片理解模型调用失败。';
        throw new Error(`P${frame.partPage} ${this.formatSeconds(frame.timestampSeconds)} 关键帧图片理解失败：${message}`);
      }

      described.push({
        ...frame,
        description: this.truncateText(description.replace(/^```[\s\S]*?```$/g, '').trim(), 240) || frame.description,
      });
    }

    return described;
  }

  private bestMediaUrl(
    items: Array<{
      baseUrl?: string;
      base_url?: string;
      backupUrl?: string[];
      backup_url?: string[];
      bandwidth?: number;
    }>,
  ): string | undefined {
    return items
      .slice()
      .sort((a, b) => Number(b.bandwidth ?? 0) - Number(a.bandwidth ?? 0))
      .flatMap((item) => [
        item.baseUrl,
        item.base_url,
        ...(item.backupUrl ?? []),
        ...(item.backup_url ?? []),
      ])
      .find((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url));
  }

  private async generateReport(
    job: AnalysisJob,
    transcript: string,
    transcriptSource: TranscriptSource,
    visualEvidence: FrameEvidence[],
  ): Promise<AnalysisReport> {
    const capability: ModelCapability = job.options.mode === 'multimodal' ? 'video' : 'text';
    const profileId = job.options.modelProfileIds[capability];
    if (!profileId) throw new BadRequestException({ message: '缺少当前分析模式需要的模型配置。' });
    const { config, apiKey } = await this.modelConfigs.getConfigWithApiKey(profileId, capability);

    let modelJson: unknown;
    try {
      const response = await this.client.chat(
        config,
        apiKey,
        [
          {
            role: 'system',
            content:
              '你是严谨的视频分析助手。必须输出合法 JSON，不要使用 Markdown 代码块。所有结论只能来自用户提供的视频元数据、分 P 信息、字幕或转写上下文、关键帧视觉证据；无法确认的内容写入 confidenceNotes。',
          },
          {
            role: 'user',
            content: this.reportPrompt(job, transcript, transcriptSource, visualEvidence),
          },
        ],
        {
          temperature: 0.2,
          maxTokens: this.maxReportTokens(job.options.depth),
          responseFormat: 'json_object',
        },
      );
      modelJson = this.parseJsonObject(response);
    } catch (error) {
      if (this.isModelFormatError(error)) {
        modelJson = await this.retryStructuredReport(config, apiKey, job, transcript, transcriptSource, visualEvidence);
      } else {
        throw error;
      }
    }

    return this.normalizeReport(modelJson, job, transcript, transcriptSource, visualEvidence);
  }

  private async retryStructuredReport(
    config: Pick<ModelConfig, 'baseUrl' | 'modelName' | 'timeoutSeconds'>,
    apiKey: string,
    job: AnalysisJob,
    transcript: string,
    transcriptSource: TranscriptSource,
    visualEvidence: FrameEvidence[],
  ): Promise<unknown | undefined> {
    try {
      const response = await this.client.chat(
        config,
        apiKey,
        [
          {
            role: 'system',
            content:
              '你是严谨的视频分析助手。只输出一个合法 JSON 对象，不要输出 Markdown、解释、转写全文或代码块。JSON 字符串内不要换行过多。',
          },
          {
            role: 'user',
            content: this.compactReportPrompt(job, transcript, transcriptSource, visualEvidence),
          },
        ],
        {
          temperature: 0.1,
          maxTokens: this.maxReportTokens(job.options.depth) + 800,
        },
      );
      return this.parseJsonObject(response);
    } catch (error) {
      this.logger.warn(`Structured report retry failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private isModelFormatError(error: unknown): boolean {
    if (error instanceof SyntaxError) return true;
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /json|格式|unexpected|expected|position|unterminated|response_format|schema/i.test(message);
  }

  private reportPrompt(
    job: AnalysisJob,
    transcript: string,
    transcriptSource: TranscriptSource,
    visualEvidence: FrameEvidence[],
  ): string {
    const selectedParts = job.video.parts.filter((part) => job.options.selectedPartCids.includes(part.cid));
    return [
      `输出语言：${job.options.outputLanguage}`,
      `分析深度：${job.options.depth}`,
      `分析模式：${job.options.mode}`,
      `是否保留时间戳：${job.options.keepTimestamps}`,
      `视频信息：${JSON.stringify(job.video)}`,
      `选择分 P：${JSON.stringify(selectedParts)}`,
      `内容上下文来源：${this.transcriptSourceLabel(transcriptSource)}`,
      `可用字幕或转写上下文：${transcript || '未读取到公开字幕。请只基于已提供元数据生成保守报告。'}`,
      `关键帧视觉证据：${this.visualEvidenceForPrompt(visualEvidence)}`,
      '如果“可用字幕或转写上下文”非空，必须优先基于该上下文生成 summary, overview, chapters, keyPoints, facts 和 conclusion；如果“关键帧视觉证据”非空，必须用它补充画面、操作、屏幕文字和推荐截图说明；不要只复述标题、简介或分 P 信息。',
      '请返回 JSON，字段必须包含 summary, overview, chapters, keyPoints, facts, conclusion, screenshots, recommendedSegments, confidenceNotes。',
      'chapters/recommendedSegments 的元素字段为 title, startSeconds, summary；keyPoints 元素字段为 title, detail；screenshots 元素字段为 url, timestampSeconds, description。screenshots 只能使用关键帧视觉证据中给出的 url；没有真实关键帧时返回 []。',
    ].join('\n\n');
  }

  private compactReportPrompt(
    job: AnalysisJob,
    transcript: string,
    transcriptSource: TranscriptSource,
    visualEvidence: FrameEvidence[],
  ): string {
    const selectedParts = job.video.parts.filter((part) => job.options.selectedPartCids.includes(part.cid));
    return [
      `输出语言：${job.options.outputLanguage}`,
      `分析深度：${job.options.depth}`,
      `视频信息：${JSON.stringify(job.video)}`,
      `选择分 P：${JSON.stringify(selectedParts)}`,
      `内容上下文来源：${this.transcriptSourceLabel(transcriptSource)}`,
      `内容上下文：${this.compactTranscriptForPrompt(transcript, job.video.title) || '未读取到字幕或转写。'}`,
      `关键帧视觉证据：${this.visualEvidenceForPrompt(visualEvidence)}`,
      '请基于内容上下文和关键帧视觉证据做分析总结，不要复述整段转写。',
      '只返回 JSON 对象，字段必须是：summary, overview, chapters, keyPoints, facts, conclusion, screenshots, recommendedSegments, confidenceNotes。',
      'summary 为 1 句话；overview 为 1 段综合概览；chapters 和 recommendedSegments 最多 5 项，每项包含 title, startSeconds, summary；keyPoints 最多 6 项，每项包含 title, detail；facts 最多 8 条；screenshots 只能使用关键帧视觉证据中的真实 url；无真实截图时返回 []。',
    ].join('\n\n');
  }

  private normalizeReport(
    value: unknown,
    job: AnalysisJob,
    transcript: string,
    transcriptSource: TranscriptSource,
    visualEvidence: FrameEvidence[],
  ): AnalysisReport {
    const fallback = this.fallbackReport(job, transcript, transcriptSource, visualEvidence);
    if (!value || typeof value !== 'object') return fallback;
    const source = value as Partial<AnalysisReport>;
    const confidenceNotes = this.textOr(source.confidenceNotes, fallback.confidenceNotes);
    const realScreenshots = this.screenshotsFromVisualEvidence(visualEvidence);
    return {
      ...fallback,
      summary: this.textOr(source.summary, fallback.summary),
      overview: this.textOr(source.overview, fallback.overview),
      chapters: this.chaptersOr(source.chapters, fallback.chapters),
      keyPoints: this.pointsOr(source.keyPoints, fallback.keyPoints),
      facts: this.stringArrayOr(source.facts, fallback.facts),
      conclusion: this.textOr(source.conclusion, fallback.conclusion),
      screenshots: realScreenshots.length
        ? this.trustedScreenshotsOr(source.screenshots, realScreenshots)
        : this.screenshotsOr(source.screenshots, fallback.screenshots),
      recommendedSegments: this.chaptersOr(source.recommendedSegments, fallback.recommendedSegments),
      confidenceNotes: this.withVisualEvidenceNote(
        this.withEvidenceNote(confidenceNotes, transcript, transcriptSource),
        visualEvidence,
      ),
    };
  }

  private fallbackReport(
    job: AnalysisJob,
    transcript: string,
    transcriptSource: TranscriptSource,
    visualEvidence: FrameEvidence[],
  ): AnalysisReport {
    const selectedParts = job.video.parts.filter((part) => job.options.selectedPartCids.includes(part.cid));
    const hasTranscript = Boolean(transcript.trim());
    const evidence = this.transcriptExcerpt(transcript);
    const sourceLabel = this.transcriptSourceLabel(transcriptSource);
    const extracted = hasTranscript
      ? this.extractReportFromTranscript(job, transcript, selectedParts.length ? selectedParts : job.video.parts)
      : undefined;
    const chapters =
      extracted?.chapters.length ? extracted.chapters : this.fallbackChapters(selectedParts.length ? selectedParts : job.video.parts, job.options);
    const metadataFacts = [
      `UP 主：${job.video.ownerName}`,
      `视频 BV 号：${job.video.bvid}`,
      `视频总时长：${job.video.duration} 秒`,
      `已选择分 P：${selectedParts.map((part) => `P${part.page} ${part.title}`).join('、')}`,
      hasTranscript ? `内容上下文来源：${sourceLabel}，长度 ${transcript.length} 字符。` : '',
      visualEvidence.length ? `关键帧视觉证据：${visualEvidence.length} 张。` : '',
    ].filter(Boolean);
    const visualSummary = this.visualEvidenceSummary(visualEvidence);
    const fallbackOverview =
      evidence
        ? `已取得${sourceLabel}，但文本模型没有返回可解析的结构化 JSON；以下为内容上下文片段：\n${evidence}`
        : visualSummary
          ? `已取得关键帧视觉证据，但模型没有返回可解析的结构化 JSON；以下为画面证据摘要：\n${visualSummary}`
          : job.video.description?.trim() ||
            `该视频由 ${job.video.ownerName} 发布，时长约 ${Math.round(job.video.duration / 60)} 分钟。`;
    const realScreenshots = this.screenshotsFromVisualEvidence(visualEvidence);

    return {
      id: randomUUID(),
      jobId: job.id,
      video: job.video,
      createdAt: new Date().toISOString(),
      summary:
        extracted?.summary ??
        `《${job.video.title}》的分析已完成，报告基于视频元数据${hasTranscript ? `和${sourceLabel}` : ''}生成。`,
      overview: extracted?.overview ? extracted.overview : fallbackOverview,
      chapters,
      keyPoints: extracted?.keyPoints.length
        ? extracted.keyPoints
        : [
            {
              title: hasTranscript ? '内容上下文' : '内容主题',
              detail: evidence || visualSummary || `视频标题和分 P 信息显示，本次分析围绕“${job.video.title}”展开。`,
            },
            {
              title: '处理范围',
              detail: `本次选择了 ${job.options.selectedPartCids.length} 个分 P，分析深度为 ${job.options.depth}。`,
            },
          ],
      facts: [...metadataFacts, ...(extracted?.facts ?? [])].slice(0, 12),
      conclusion: extracted?.conclusion ?? '当前报告未从视频内容中提取到明确的作者结论或立场，请结合原视频核对。',
      screenshots: realScreenshots.length ? realScreenshots : this.fallbackScreenshots(job),
      recommendedSegments: chapters.slice(0, Math.min(3, chapters.length)),
      confidenceNotes: hasTranscript
        ? extracted
          ? this.withVisualEvidenceNote(
              `文本模型没有返回可解析的结构化 JSON；系统已改用本地规则从${sourceLabel}中提炼摘要、要点和结论。报告可用于快速理解主题，但章节时间和细节仍需结合原视频核对。`,
              visualEvidence,
            )
          : this.withVisualEvidenceNote(
              `报告基于视频元数据和${sourceLabel}生成；模型结构化输出不可解析时会保留上下文片段作为证据。`,
              visualEvidence,
            )
        : this.withVisualEvidenceNote(
            '未读取到公开字幕或真实音频转写，报告主要基于视频元数据、分 P 信息和可用视觉证据生成；具体观点需以原视频为准。',
            visualEvidence,
          ),
    };
  }

  private extractReportFromTranscript(
    job: AnalysisJob,
    transcript: string,
    parts: VideoPart[],
  ): ExtractiveReportDraft | undefined {
    const sentences = this.transcriptSentences(transcript, job.video.title);
    if (!sentences.length) return undefined;

    const limits = this.extractiveLimits(job.options.depth);
    const ranked = this.rankTranscriptSentences(job, sentences);
    const highlights = this.uniqueTexts(ranked.slice(0, limits.keyPoints + 3).sort((a, b) => a.index - b.index).map((item) => item.text));
    const overviewSentences = highlights.slice(0, limits.overviewSentences);
    const overview = this.truncateText(
      overviewSentences.join('') || this.transcriptExcerpt(transcript),
      limits.overviewChars,
    );

    const summaryDetails = highlights
      .slice(0, 3)
      .map((sentence) => this.truncateText(sentence.replace(/[。！？!?；;]$/, ''), 72))
      .join('；');
    const summary = this.ensurePeriod(
      this.truncateText(
        summaryDetails
          ? `本视频围绕“${this.cleanReportTitle(job.video.title)}”展开，重点包括${summaryDetails}`
          : `本视频围绕“${this.cleanReportTitle(job.video.title)}”展开，主要内容来自已取得的转写文本`,
        260,
      ),
    );

    const keyPoints = highlights.slice(0, limits.keyPoints).map((sentence) => ({
      title: this.sentenceTitle(sentence),
      detail: this.ensurePeriod(this.truncateText(sentence, 260)),
    }));

    const chapterSeeds = this.uniqueRankedSentences(ranked.slice(0, limits.chapters));
    const chapters = chapterSeeds
      .sort((a, b) => a.index - b.index)
      .map((item, order) => ({
        title: this.sentenceTitle(item.text) || `片段 ${order + 1}`,
        startSeconds: this.estimatedStartSeconds(job, item.index, sentences.length, order, chapterSeeds.length),
        summary: this.ensurePeriod(this.truncateText(item.text, 220)),
      }));

    const facts = this.extractFactSentences(sentences, limits.facts);
    const conclusion = this.extractConclusion(sentences, highlights, parts);

    return {
      summary,
      overview: this.ensurePeriod(overview),
      chapters,
      keyPoints,
      facts,
      conclusion,
    };
  }

  private compactTranscriptForPrompt(transcript: string, title?: string): string {
    const text = this.cleanTranscriptText(transcript, title);
    if (text.length <= 8000) return text;
    const head = text.slice(0, 3200);
    const middleStart = Math.max(0, Math.floor(text.length / 2) - 1200);
    const middle = text.slice(middleStart, middleStart + 2400);
    const tail = text.slice(-2400);
    return [head, middle, tail].join('\n...\n');
  }

  private transcriptSentences(transcript: string, title?: string): string[] {
    const text = this.cleanTranscriptText(transcript, title);
    if (!text) return [];
    const sentences = (text.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [])
      .map((sentence) => this.normalizeSentence(sentence))
      .filter((sentence) => sentence.length >= 10);

    if (sentences.length) return sentences.map((sentence) => this.truncateText(sentence, 360));

    const chunks: string[] = [];
    for (let index = 0; index < text.length; index += 180) {
      const chunk = this.normalizeSentence(text.slice(index, index + 180));
      if (chunk.length >= 10) chunks.push(this.ensurePeriod(chunk));
    }
    return chunks;
  }

  private cleanTranscriptText(transcript: string, title?: string): string {
    const text = transcript
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !(/^P\d+\s+/i.test(line) && line.length < 120))
      .map((line) => line.replace(/^P\d+\s+/i, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const normalizedTitle = title?.replace(/\s+/g, ' ').trim();
    if (normalizedTitle && text.startsWith(normalizedTitle)) {
      return text.slice(normalizedTitle.length).trim();
    }
    return text;
  }

  private rankTranscriptSentences(job: AnalysisJob, sentences: string[]): RankedSentence[] {
    const titleTokens = this.significantTokens(job.video.title);
    const importantPattern =
      /宣布|发布|推出|更新|确认|指出|显示|建议|调查|故障|异常|封禁|订阅|模型|开源|功能|插件|安全|漏洞|升级|用户|价格|测试|作弊|基准|agent|codex|openai|deepseek|google/gi;

    return sentences
      .map((text, index) => {
        const lower = text.toLowerCase();
        const tokenScore = titleTokens.reduce((score, token) => score + (lower.includes(token) ? 2 : 0), 0);
        const keywordScore = (text.match(importantPattern) ?? []).length * 3;
        const numberScore = /[0-9]/.test(text) ? 1.5 : 0;
        const lengthScore = text.length >= 28 && text.length <= 220 ? 2 : text.length > 300 ? -1 : 0;
        const positionScore = Math.max(0, 2 - index * 0.08);
        return {
          index,
          text,
          score: tokenScore + keywordScore + numberScore + lengthScore + positionScore,
        };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index);
  }

  private extractFactSentences(sentences: string[], limit: number): string[] {
    const factPattern = /[0-9]|宣布|发布|推出|更新|确认|指出|显示|建议|停止|开放|上线|修复|升级|调查|故障|漏洞|模型|功能|服务/;
    return this.uniqueTexts(sentences.filter((sentence) => factPattern.test(sentence)))
      .slice(0, limit)
      .map((sentence) => this.ensurePeriod(this.truncateText(sentence, 180)));
  }

  private extractConclusion(sentences: string[], highlights: string[], parts: VideoPart[]): string {
    const conclusionPattern = /总体|最后|因此|所以|建议|需要|应当|值得|风险|影响|问题|结论|官方|用户/;
    const candidate =
      [...sentences].reverse().find((sentence) => conclusionPattern.test(sentence)) ??
      highlights.at(-1) ??
      sentences.at(-1);
    if (candidate) {
      return this.ensurePeriod(this.truncateText(`综合转写内容，视频结论可概括为：${candidate}`, 260));
    }
    return `本次选择了 ${parts.length} 个分 P，当前报告基于转写文本做保守总结，细节请结合原视频核对。`;
  }

  private extractiveLimits(depth: string): {
    overviewSentences: number;
    overviewChars: number;
    keyPoints: number;
    chapters: number;
    facts: number;
  } {
    if (depth === 'quick') {
      return { overviewSentences: 3, overviewChars: 520, keyPoints: 4, chapters: 4, facts: 6 };
    }
    if (depth === 'deep') {
      return { overviewSentences: 7, overviewChars: 1100, keyPoints: 8, chapters: 8, facts: 10 };
    }
    return { overviewSentences: 5, overviewChars: 780, keyPoints: 6, chapters: 6, facts: 8 };
  }

  private uniqueRankedSentences(items: RankedSentence[]): RankedSentence[] {
    const seen = new Set<string>();
    const result: RankedSentence[] = [];
    for (const item of items) {
      const key = this.normalizeSentence(item.text).slice(0, 80);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  }

  private uniqueTexts(items: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
      const text = this.normalizeSentence(item);
      const key = text.slice(0, 80);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(text);
    }
    return result;
  }

  private significantTokens(text: string): string[] {
    const tokens = text.match(/[A-Za-z][A-Za-z0-9+.-]{1,}|[\u4e00-\u9fa5]{2,}/g) ?? [];
    return this.uniqueTexts(
      tokens.flatMap((token) => {
        const lower = token.toLowerCase();
        if (/^[\u4e00-\u9fa5]+$/.test(token) && token.length > 8) {
          return [lower.slice(0, 4), lower.slice(-4)];
        }
        return [lower];
      }),
    ).filter((token) => token.length >= 2);
  }

  private sentenceTitle(sentence: string): string {
    const clause = sentence
      .replace(/^(此外|同时|另外|接下来|最后|然后|并且|而且|不过|但是|官方称|官方宣布)/, '')
      .split(/[，,。；;：:！？!?]/)[0]
      .trim();
    return this.truncateText(clause || '内容要点', 28);
  }

  private estimatedStartSeconds(
    job: AnalysisJob,
    sentenceIndex: number,
    sentenceCount: number,
    order: number,
    chapterCount: number,
  ): number {
    if (!job.options.keepTimestamps) return 0;
    if (sentenceCount <= 1) {
      return Math.round((job.video.duration / Math.max(chapterCount, 1)) * order);
    }
    return Math.min(
      job.video.duration,
      Math.round((job.video.duration * sentenceIndex) / Math.max(sentenceCount - 1, 1)),
    );
  }

  private cleanReportTitle(title: string): string {
    return title.replace(/\s+/g, ' ').trim();
  }

  private normalizeSentence(sentence: string): string {
    return sentence.replace(/\s+/g, ' ').trim();
  }

  private ensurePeriod(text: string): string {
    const cleaned = text.trim();
    if (!cleaned) return cleaned;
    return /[。！？.!?]$/.test(cleaned) ? cleaned : `${cleaned}。`;
  }

  private truncateText(text: string, maxLength: number): string {
    const cleaned = text.trim();
    if (cleaned.length <= maxLength) return cleaned;
    return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
  }

  private withEvidenceNote(note: string, transcript: string, transcriptSource: TranscriptSource): string {
    if (!transcript.trim()) return note;
    return `${note}\n\n内容上下文来源：${this.transcriptSourceLabel(transcriptSource)}，长度 ${transcript.length} 字符。`;
  }

  private transcriptSourceLabel(source: TranscriptSource): string {
    if (source === 'asr') return 'ASR 音频转写';
    if (source === 'subtitle') return 'Bilibili 公开字幕';
    return '无';
  }

  private transcriptExcerpt(transcript: string): string {
    return transcript.trim().replace(/\s+/g, ' ').slice(0, 1200);
  }

  private fallbackChapters(parts: VideoPart[], options: AnalysisOptions): ReportChapter[] {
    let cursor = 0;
    return parts.slice(0, options.depth === 'quick' ? 4 : options.depth === 'standard' ? 8 : 12).map((part) => {
      const chapter = {
        title: `P${part.page} ${part.title}`,
        startSeconds: options.keepTimestamps ? cursor : 0,
        summary: `该章节对应分 P“${part.title}”，时长约 ${part.duration} 秒。`,
      };
      cursor += part.duration;
      return chapter;
    });
  }

  private fallbackScreenshots(job: AnalysisJob): ReportScreenshot[] {
    if (!job.options.generateScreenshots || job.options.maxScreenshots <= 0 || !job.video.coverUrl) return [];
    return [
      {
        url: job.video.coverUrl,
        timestampSeconds: 0,
        description: '视频封面图，可作为报告展示的关键画面参考。',
      },
    ];
  }

  private screenshotsFromVisualEvidence(visualEvidence: FrameEvidence[]): ReportScreenshot[] {
    return visualEvidence.map((frame) => ({
      url: frame.publicUrl,
      timestampSeconds: frame.timestampSeconds,
      description: frame.description,
    }));
  }

  private trustedScreenshotsOr(value: unknown, trusted: ReportScreenshot[]): ReportScreenshot[] {
    if (!Array.isArray(value)) return trusted;
    const parsed = this.screenshotsOr(value, []);
    const parsedByUrl = new Map(parsed.map((item) => [item.url, item]));
    return trusted.map((item) => {
      const modelItem = parsedByUrl.get(item.url);
      return modelItem ? { ...item, description: modelItem.description || item.description } : item;
    });
  }

  private visualEvidenceForPrompt(visualEvidence: FrameEvidence[]): string {
    if (!visualEvidence.length) return '[]';
    return JSON.stringify(
      visualEvidence.map((frame) => ({
        url: frame.publicUrl,
        part: `P${frame.partPage} ${frame.partTitle}`,
        timestampSeconds: frame.timestampSeconds,
        description: this.truncateText(frame.description, 320),
      })),
    );
  }

  private visualEvidenceSummary(visualEvidence: FrameEvidence[]): string {
    return visualEvidence
      .slice(0, 8)
      .map(
        (frame) =>
          `P${frame.partPage} ${this.formatSeconds(frame.timestampSeconds)}：${this.truncateText(frame.description, 160)}`,
      )
      .join('\n');
  }

  private withVisualEvidenceNote(note: string, visualEvidence: FrameEvidence[]): string {
    if (!visualEvidence.length) return note;
    return `${note}\n\n关键帧视觉证据：已从公开视频流抽取并理解 ${visualEvidence.length} 张关键帧。`;
  }

  private fallbackAnswer(report: AnalysisReport, question: string): string {
    if (/结论|总结|主要|summary/i.test(question)) {
      return `${report.summary}\n\n${report.conclusion}`;
    }
    if (/章节|时间|片段|timestamp|chapter/i.test(question)) {
      return report.chapters
        .map((chapter) => `${chapter.startSeconds} 秒：${chapter.title} - ${chapter.summary}`)
        .join('\n');
    }
    return `当前报告中可确认的信息是：${report.overview}\n\n如果你问到的细节没有出现在报告、章节或事实列表中，我无法从当前视频确认。`;
  }

  private async imageDataUrl(filePath: string): Promise<string> {
    const bytes = await readFile(filePath);
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
  }

  private async fetchToFile(
    url: string,
    filePath: string,
    maxBytes: number,
    referer: string,
    label: string,
  ): Promise<number> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let received = 0;
    try {
      await mkdir(dirname(filePath), { recursive: true });
      const response = await fetch(url, {
        headers: {
          Referer: referer,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Bilibili ${label}下载失败。`);

      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > maxBytes) throw new Error(`${label}文件过大，当前最大支持 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
      if (!response.body) throw new Error(`Bilibili ${label}下载响应为空。`);

      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
          if (received > maxBytes) {
            callback(new Error(`${label}文件过大，当前最大支持 ${Math.round(maxBytes / 1024 / 1024)} MB。`));
            return;
          }
          callback(null, chunk);
        },
      });

      await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(filePath));
      if (received === 0) throw new Error(`Bilibili ${label}下载为空。`);
      return received;
    } catch (error) {
      await this.safeUnlink(filePath);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Bilibili ${label}下载超时。`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async runFfmpeg(args: string[], context: string): Promise<void> {
    const timeoutMs = this.envNumber('BVA_FFMPEG_TIMEOUT_SECONDS', 120, 5, 1800) * 1000;
    const ffmpegPath = this.resolveFfmpegPath();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let stderr = '';
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const child = spawn(ffmpegPath, args, { windowsHide: true });
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(new Error(`${context}：ffmpeg 执行超时。`));
      }, timeoutMs);

      child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-3000);
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'EFTYPE') {
          settle(new Error(this.ffmpegUnavailableMessage(error.code)));
          return;
        }
        settle(error);
      });
      child.on('close', (code) => {
        if (code === 0) {
          settle();
          return;
        }
        const detail = stderr.trim() ? this.truncateText(stderr.trim().replace(/\s+/g, ' '), 600) : `退出码 ${code}`;
        settle(new Error(`${context}：${detail}`));
      });
    });
  }

  private resolveFfmpegPath(): string {
    const configured = process.env.BVA_FFMPEG_PATH?.trim();
    if (configured) return configured;
    if (this.commandExists('ffmpeg')) return 'ffmpeg';
    try {
      const staticPath = require('ffmpeg-static') as string | null;
      if (staticPath) return staticPath;
    } catch {
      // Fall through to PATH lookup.
    }
    return 'ffmpeg';
  }

  private commandExists(command: string): boolean {
    const paths = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
    const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
    for (const basePath of paths) {
      if (!basePath.trim()) continue;
      for (const extension of extensions) {
        const candidate = resolve(basePath, `${command}${extension.toLowerCase() === '.exe' ? '.exe' : extension}`);
        try {
          const candidateStat = require('node:fs').statSync(candidate) as { isFile: () => boolean };
          if (candidateStat.isFile()) return true;
        } catch {
          // Keep searching PATH.
        }
      }
    }
    return false;
  }

  private ffmpegUnavailableMessage(code?: string): string {
    if (code === 'EFTYPE') {
      return 'ffmpeg 可执行文件格式不适用于当前系统。请安装系统 ffmpeg，或将 BVA_FFMPEG_PATH 指向可运行的 ffmpeg.exe。';
    }
    return '未找到 ffmpeg，请安装 ffmpeg、配置 BVA_FFMPEG_PATH，或重新安装可用的 ffmpeg-static。';
  }

  private runtimeRoot(): string {
    const configured = process.env.BVA_RUNTIME_DIR?.trim();
    if (!configured) return this.storage.dataPath('runtime');
    return isAbsolute(configured) ? resolve(configured) : resolve(process.cwd(), configured);
  }

  private jobRuntimeDir(jobId: string): string {
    return resolve(this.runtimeRoot(), jobId);
  }

  private jobFramesDir(jobId: string): string {
    return resolve(this.reportAssetsRoot(), jobId);
  }

  private reportAssetsRoot(): string {
    const configured = process.env.BVA_REPORT_ASSETS_DIR?.trim();
    if (!configured) return this.storage.dataPath('report-assets');
    return isAbsolute(configured) ? resolve(configured) : resolve(process.cwd(), configured);
  }

  private jobVideosDir(jobId: string): string {
    return resolve(this.jobRuntimeDir(jobId), 'video');
  }

  private publicFrameUrl(jobId: string, fileName: string): string {
    return `/api/analysis/assets/${encodeURIComponent(jobId)}/${encodeURIComponent(fileName)}`;
  }

  private partStartSeconds(job: AnalysisJob, target: VideoPart): number {
    let cursor = 0;
    for (const part of [...job.video.parts].sort((a, b) => a.page - b.page)) {
      if (part.cid === target.cid) return cursor;
      cursor += part.duration;
    }
    return 0;
  }

  private maxAudioBytes(): number {
    return this.envNumber('BVA_MAX_AUDIO_MB', 100, 1, 2048) * 1024 * 1024;
  }

  private maxVideoBytes(): number {
    return this.envNumber('BVA_MAX_VIDEO_MB', 500, 1, 4096) * 1024 * 1024;
  }

  private formatSeconds(totalSeconds: number): string {
    const rounded = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const seconds = rounded % 60;
    const base = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    return hours > 0 ? `${hours}:${base}` : base;
  }

  private envNumber(name: string, fallback: number, min: number, max: number): number {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  private isPathInside(parent: string, child: string): boolean {
    const parentPath = resolve(parent);
    const childPath = resolve(child);
    const path = relative(parentPath, childPath);
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  }

  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch {
      // Best-effort cleanup.
    }
  }

  private parseJsonObject(raw: string): unknown {
    const cleaned = raw
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('模型响应格式不兼容。');
    return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  }

  private textOr(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  private stringArrayOr(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) return fallback;
    const result = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
    return result.length ? result : fallback;
  }

  private chaptersOr(value: unknown, fallback: ReportChapter[]): ReportChapter[] {
    if (!Array.isArray(value)) return fallback;
    const result = value
      .map((item) => {
        if (!item || typeof item !== 'object') return undefined;
        const chapter = item as Record<string, unknown>;
        const title = this.textOr(chapter.title, '');
        const summary = this.textOr(chapter.summary, '');
        const startSeconds = Number(chapter.startSeconds);
        if (!title || !summary || !Number.isFinite(startSeconds)) return undefined;
        return { title, summary, startSeconds: Math.max(0, startSeconds) };
      })
      .filter((item): item is ReportChapter => Boolean(item));
    return result.length ? result : fallback;
  }

  private pointsOr(value: unknown, fallback: ReportPoint[]): ReportPoint[] {
    if (!Array.isArray(value)) return fallback;
    const result = value
      .map((item) => {
        if (!item || typeof item !== 'object') return undefined;
        const point = item as Record<string, unknown>;
        const title = this.textOr(point.title, '');
        const detail = this.textOr(point.detail, '');
        if (!title || !detail) return undefined;
        return { title, detail };
      })
      .filter((item): item is ReportPoint => Boolean(item));
    return result.length ? result : fallback;
  }

  private screenshotsOr(value: unknown, fallback: ReportScreenshot[]): ReportScreenshot[] {
    if (!Array.isArray(value)) return fallback;
    const result = value
      .map((item) => {
        if (!item || typeof item !== 'object') return undefined;
        const screenshot = item as Record<string, unknown>;
        const url = this.textOr(screenshot.url, '');
        const description = this.textOr(screenshot.description, '');
        const timestampSeconds = Number(screenshot.timestampSeconds);
        if (!url || !description || !Number.isFinite(timestampSeconds)) return undefined;
        return { url, description, timestampSeconds: Math.max(0, timestampSeconds) };
      })
      .filter((item): item is ReportScreenshot => Boolean(item));
    return result.length ? result : fallback;
  }

  private async validateCreatePayload(payload: unknown): Promise<CreateJobDto> {
    assertPlainObject(payload, '创建任务请求不能为空。');
    const video = payload.video as VideoInfo;
    const options = payload.options as AnalysisOptions;
    if (!video || typeof video !== 'object') throw new BadRequestException({ message: '视频信息不能为空。' });
    if (!options || typeof options !== 'object') throw new BadRequestException({ message: '分析选项不能为空。' });

    if (!video.bvid?.trim()) throw new BadRequestException({ message: 'BV 号不能为空。' });
    if (!/^https?:\/\/(?:www\.)?bilibili\.com\/video\/BV[0-9A-Za-z]{10}/i.test(video.url)) {
      throw new BadRequestException({ message: '视频 URL 必须是 Bilibili 视频地址。' });
    }
    if (!video.isPublic) throw new BadRequestException({ message: '当前仅支持公开视频。' });
    if (!Array.isArray(video.parts) || video.parts.length === 0) {
      throw new BadRequestException({ message: '视频分 P 列表不能为空。' });
    }
    if (!Array.isArray(options.selectedPartCids) || options.selectedPartCids.length === 0) {
      throw new BadRequestException({ message: '请至少选择一个分 P。' });
    }
    const partCids = new Set(video.parts.map((part) => part.cid));
    if (options.selectedPartCids.some((cid) => !partCids.has(cid))) {
      throw new BadRequestException({ message: '选择的分 P 不存在。' });
    }
    if (!ANALYSIS_DEPTHS.includes(options.depth)) {
      throw new BadRequestException({ message: '分析深度不受支持。' });
    }
    if (!options.outputLanguage?.trim()) throw new BadRequestException({ message: '输出语言不能为空。' });
    if (!Number.isInteger(options.maxScreenshots) || options.maxScreenshots < 0 || options.maxScreenshots > 20) {
      throw new BadRequestException({ message: '最大截图数量必须在 0 到 20 之间。' });
    }
    if (options.mode !== 'subtitle' && options.mode !== 'multimodal') {
      throw new BadRequestException({ message: '分析模式不受支持。' });
    }

    const required: ModelCapability[] =
      options.mode === 'multimodal'
        ? options.generateScreenshots
          ? ['video', 'asr', 'image']
          : ['video', 'asr']
        : options.generateScreenshots
          ? ['text', 'asr', 'image']
          : ['text', 'asr'];
    for (const capability of required) {
      const id = options.modelProfileIds?.[capability];
      if (!id) throw new BadRequestException({ message: '模型能力与当前分析模式不匹配。' });
      await this.modelConfigs.getConfigWithApiKey(id, capability);
    }

    return { video, options };
  }

  private async fetchJson<T>(url: string, timeoutMs: number, referer: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          Referer: referer,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('request failed');
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error('response too large');
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchBinary(url: string, maxBytes: number, referer: string): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        headers: {
          Referer: referer,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Bilibili 音频下载失败。');

      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > maxBytes) throw new Error('音频文件过大，当前轻量 ASR 链路无法处理该分 P。');

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) throw new Error('音频文件过大，当前轻量 ASR 链路无法处理该分 P。');
      if (buffer.byteLength === 0) throw new Error('Bilibili 音频下载为空。');
      return buffer;
    } finally {
      clearTimeout(timeout);
    }
  }

  private maxReportTokens(depth: string): number {
    if (depth === 'quick') return 1200;
    if (depth === 'deep') return 3200;
    return 2200;
  }

  private readableFailure(error: unknown): string {
    if (error && typeof error === 'object' && 'getResponse' in error) {
      const response = (error as { getResponse: () => unknown }).getResponse();
      if (typeof response === 'object' && response && 'message' in response) {
        const message = (response as { message?: unknown }).message;
        return Array.isArray(message) ? message.join('；') : String(message);
      }
    }
    if (error instanceof Error && error.message) return this.normalizeStoredFailure(error.message);
    return '分析任务失败，请检查模型配置、视频可访问性或稍后重试。';
  }

  private normalizeStoredFailure(message: string): string {
    if (/spawn\s+EFTYPE/i.test(message)) return this.ffmpegUnavailableMessage('EFTYPE');
    if (/spawn\s+ENOENT/i.test(message)) return this.ffmpegUnavailableMessage('ENOENT');
    return message;
  }

  private async persistJobs(): Promise<void> {
    await this.storage.writeJson(this.jobsFile, [...this.jobs.values()]);
  }

  private async persistReports(): Promise<void> {
    await this.storage.writeJson(this.reportsFile, [...this.reports.values()]);
  }

  private async cleanupExpiredRuntimeData(): Promise<void> {
    const root = this.runtimeRoot();
    const ttlMs = this.envNumber('BVA_MEDIA_CACHE_TTL_HOURS', 24, 1, 24 * 30) * 60 * 60 * 1000;
    const cutoff = Date.now() - ttlMs;
    try {
      await mkdir(root, { recursive: true });
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const target = resolve(root, entry.name);
        if (!this.isPathInside(root, target)) continue;
        const targetStat = await stat(target);
        if (targetStat.mtimeMs < cutoff) {
          await rm(target, { recursive: true, force: true });
        }
      }
    } catch (error) {
      this.logger.warn(`Runtime cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async cleanupJobRuntimeData(jobId: string): Promise<void> {
    const root = this.runtimeRoot();
    const target = this.jobRuntimeDir(jobId);
    if (!this.isPathInside(root, target)) return;
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn(`Runtime job cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async cleanupJobReportAssets(jobId: string): Promise<void> {
    const root = this.reportAssetsRoot();
    const target = resolve(root, jobId);
    if (!this.isPathInside(root, target)) return;
    await rm(target, { recursive: true, force: true });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
