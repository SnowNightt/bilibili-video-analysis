import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import type { ModelConfigDraft } from '../common/domain';
import { ModelConfigsService } from './model-configs.service';

@Controller('model-configs')
export class ModelConfigsController {
  constructor(private readonly modelConfigs: ModelConfigsService) {}

  @Get()
  async list() {
    return this.modelConfigs.list();
  }

  @Post('test')
  async test(@Body() draft: ModelConfigDraft) {
    const config = await this.modelConfigs.testAndSave(draft);
    return { ok: true, config };
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.modelConfigs.delete(id);
    return { ok: true };
  }
}
