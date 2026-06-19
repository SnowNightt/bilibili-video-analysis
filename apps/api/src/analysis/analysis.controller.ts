import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AnalysisService } from './analysis.service';

@Controller('analysis')
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

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

  @Post('reports/:id/questions')
  async answerQuestion(@Param('id') id: string, @Body() payload: unknown) {
    return this.analysis.answerQuestion(id, payload);
  }
}
