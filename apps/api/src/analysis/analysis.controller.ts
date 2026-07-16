import { Body, Controller, Delete, Get, Param, Post, StreamableFile } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { AnalysisService } from './analysis.service';

@Controller('analysis')
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  @Get('jobs')
  listJobs() {
    return this.analysis.listJobs();
  }

  @Get('videos/:bvid')
  getVideoInfo(@Param('bvid') bvid: string) {
    return this.analysis.getVideoInfo(bvid);
  }

  @Post('jobs')
  async createJob(@Body() payload: unknown) {
    return this.analysis.createJob(payload);
  }

  @Get('jobs/:id')
  getJob(@Param('id') id: string) {
    return this.analysis.getJob(id);
  }

  @Post('jobs/:id/cancel')
  async cancelJob(@Param('id') id: string) {
    return this.analysis.cancelJob(id);
  }

  @Get('reports/:id')
  getReport(@Param('id') id: string) {
    return this.analysis.getReport(id);
  }

  @Delete('jobs/:id')
  async deleteJob(@Param('id') id: string) {
    await this.analysis.deleteJob(id);
    return { ok: true };
  }

  @Get('assets/:jobId/:fileName')
  async getAsset(@Param('jobId') jobId: string, @Param('fileName') fileName: string) {
    const asset = await this.analysis.getRuntimeAsset(jobId, fileName);
    return new StreamableFile(createReadStream(asset.filePath), { type: asset.mimeType });
  }

  @Post('reports/:id/questions')
  async answerQuestion(@Param('id') id: string, @Body() payload: unknown) {
    return this.analysis.answerQuestion(id, payload);
  }
}
