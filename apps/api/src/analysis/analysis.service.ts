import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ACTIVE_JOB_STATUSES,
  ANALYSIS_DEPTHS,
  type AnalysisJob,
  type AnalysisOptions,
  type AnalysisReport,
  type ConversationMessage,
  type JobStatus,
  type ModelCapability,
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

  getReport(id: string): AnalysisReport {
    const report = this.reports.get(id);
    if (!report) throw new NotFoundException({ message: '报告不存在。' });
    return report;
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
        await this.advance(id, 'extracting_audio', 34, '正在整理音频和字幕上下文。');
      }

      if (job.options.generateScreenshots) {
        await this.advance(id, 'extracting_frames', 68, '正在提取关键画面并整理截图上下文。');
      }

      await this.advance(id, 'analyzing', 82, '正在调用模型生成结构化分析。');
      const report = await this.generateReport(this.getJob(id), transcript, transcriptSource);

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
      this.logger.log(`Analysis job completed: ${id}`);
    } catch (error) {
      if (error instanceof JobCancelledError) return;
      const job = this.jobs.get(id);
      if (!job || job.status === 'cancelled') return;
      job.status = 'failed';
      job.errorMessage = this.readableFailure(error);
      job.currentStage = '任务执行失败。';
      job.completedAt = new Date().toISOString();
      await this.persistJobs();
      this.logger.warn(`Analysis job failed: ${id}`);
    } finally {
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

    const bytes = await this.fetchBinary(audioUrl, 50 * 1024 * 1024, job.video.url);
    return {
      bytes,
      fileName: `${job.bvid}-p${part.page}.m4a`,
    };
  }

  private async generateReport(
    job: AnalysisJob,
    transcript: string,
    transcriptSource: TranscriptSource,
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
              '你是严谨的视频分析助手。必须输出合法 JSON，不要使用 Markdown 代码块。所有结论只能来自用户提供的视频元数据、分 P 信息和字幕上下文；无法确认的内容写入 confidenceNotes。',
          },
          {
            role: 'user',
            content: this.reportPrompt(job, transcript, transcriptSource),
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
      const message = error instanceof Error ? error.message : '';
      if (message.includes('JSON') || message.includes('格式')) {
        modelJson = undefined;
      } else {
        throw error;
      }
    }

    return this.normalizeReport(modelJson, job, transcript, transcriptSource);
  }

  private reportPrompt(job: AnalysisJob, transcript: string, transcriptSource: TranscriptSource): string {
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
      '如果“可用字幕或转写上下文”非空，必须优先基于该上下文生成 summary, overview, chapters, keyPoints, facts 和 conclusion；不要只复述标题、简介或分 P 信息。',
      '请返回 JSON，字段必须包含 summary, overview, chapters, keyPoints, facts, conclusion, screenshots, recommendedSegments, confidenceNotes。',
      'chapters/recommendedSegments 的元素字段为 title, startSeconds, summary；keyPoints 元素字段为 title, detail；screenshots 元素字段为 url, timestampSeconds, description。',
    ].join('\n\n');
  }

  private normalizeReport(
    value: unknown,
    job: AnalysisJob,
    transcript: string,
    transcriptSource: TranscriptSource,
  ): AnalysisReport {
    const fallback = this.fallbackReport(job, transcript, transcriptSource);
    if (!value || typeof value !== 'object') return fallback;
    const source = value as Partial<AnalysisReport>;
    const confidenceNotes = this.textOr(source.confidenceNotes, fallback.confidenceNotes);
    return {
      ...fallback,
      summary: this.textOr(source.summary, fallback.summary),
      overview: this.textOr(source.overview, fallback.overview),
      chapters: this.chaptersOr(source.chapters, fallback.chapters),
      keyPoints: this.pointsOr(source.keyPoints, fallback.keyPoints),
      facts: this.stringArrayOr(source.facts, fallback.facts),
      conclusion: this.textOr(source.conclusion, fallback.conclusion),
      screenshots: this.screenshotsOr(source.screenshots, fallback.screenshots),
      recommendedSegments: this.chaptersOr(source.recommendedSegments, fallback.recommendedSegments),
      confidenceNotes: this.withEvidenceNote(confidenceNotes, transcript, transcriptSource),
    };
  }

  private fallbackReport(
    job: AnalysisJob,
    transcript: string,
    transcriptSource: TranscriptSource,
  ): AnalysisReport {
    const selectedParts = job.video.parts.filter((part) => job.options.selectedPartCids.includes(part.cid));
    const chapters = this.fallbackChapters(selectedParts.length ? selectedParts : job.video.parts, job.options);
    const hasTranscript = Boolean(transcript.trim());
    const evidence = this.transcriptExcerpt(transcript);
    const sourceLabel = this.transcriptSourceLabel(transcriptSource);
    return {
      id: randomUUID(),
      jobId: job.id,
      video: job.video,
      createdAt: new Date().toISOString(),
      summary: `《${job.video.title}》的分析已完成，报告基于视频元数据${hasTranscript ? `和${sourceLabel}` : ''}生成。`,
      overview: evidence
        ? `已取得${sourceLabel}，但模型没有返回可解析的结构化 JSON。以下为内容上下文片段：\n${evidence}`
        : job.video.description?.trim() ||
          `该视频由 ${job.video.ownerName} 发布，时长约 ${Math.round(job.video.duration / 60)} 分钟。`,
      chapters,
      keyPoints: [
        {
          title: hasTranscript ? '内容上下文' : '内容主题',
          detail: evidence || `视频标题和分 P 信息显示，本次分析围绕“${job.video.title}”展开。`,
        },
        {
          title: '处理范围',
          detail: `本次选择了 ${job.options.selectedPartCids.length} 个分 P，分析深度为 ${job.options.depth}。`,
        },
      ],
      facts: [
        `UP 主：${job.video.ownerName}`,
        `视频 BV 号：${job.video.bvid}`,
        `视频总时长：${job.video.duration} 秒`,
        `已选择分 P：${selectedParts.map((part) => `P${part.page} ${part.title}`).join('、')}`,
        hasTranscript ? `内容上下文来源：${sourceLabel}，长度 ${transcript.length} 字符。` : '',
      ].filter(Boolean),
      conclusion: '当前报告未从视频内容中提取到明确的作者结论或立场，请结合原视频核对。',
      screenshots: this.fallbackScreenshots(job),
      recommendedSegments: chapters.slice(0, Math.min(3, chapters.length)),
      confidenceNotes: hasTranscript
        ? `报告基于视频元数据和${sourceLabel}生成；模型结构化输出不可解析时会保留上下文片段作为证据。未能验证画面细节。`
        : '未读取到公开字幕或真实媒体内容，报告主要基于视频元数据和分 P 信息生成；具体观点需以原视频为准。',
    };
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
        ? ['video']
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
    if (error instanceof Error && error.message) return error.message;
    return '分析任务失败，请检查模型配置、视频可访问性或稍后重试。';
  }

  private async persistJobs(): Promise<void> {
    await this.storage.writeJson(this.jobsFile, [...this.jobs.values()]);
  }

  private async persistReports(): Promise<void> {
    await this.storage.writeJson(this.reportsFile, [...this.reports.values()]);
  }

  private async cleanupExpiredRuntimeData(): Promise<void> {
    this.logger.debug('Runtime cleanup tick completed.');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
