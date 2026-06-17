import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly baseDir = resolve(process.env.BVA_DATA_DIR ?? resolve(process.cwd(), 'data'));

  async onModuleInit() {
    await mkdir(this.baseDir, { recursive: true });
  }

  dataPath(fileName: string): string {
    return resolve(this.baseDir, fileName);
  }

  async ensureDir(fileName: string): Promise<void> {
    await mkdir(dirname(this.dataPath(fileName)), { recursive: true });
  }

  async readJson<T>(fileName: string, fallback: T): Promise<T> {
    try {
      const content = await readFile(this.dataPath(fileName), 'utf8');
      return JSON.parse(content) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Ignoring unreadable local data file: ${fileName}`);
      }
      return fallback;
    }
  }

  async writeJson<T>(fileName: string, value: T): Promise<void> {
    await this.ensureDir(fileName);
    await writeFile(this.dataPath(fileName), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
}
