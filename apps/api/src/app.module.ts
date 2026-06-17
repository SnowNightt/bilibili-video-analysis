import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis/analysis.controller';
import { AnalysisService } from './analysis/analysis.service';
import { OpenAiCompatibleClient } from './model-configs/openai-compatible.client';
import { ModelConfigsController } from './model-configs/model-configs.controller';
import { ModelConfigsService } from './model-configs/model-configs.service';
import { SecretsService } from './storage/secrets.service';
import { StorageService } from './storage/storage.service';

@Module({
  controllers: [AnalysisController, ModelConfigsController],
  providers: [
    AnalysisService,
    ModelConfigsService,
    OpenAiCompatibleClient,
    SecretsService,
    StorageService,
  ],
})
export class AppModule {}
