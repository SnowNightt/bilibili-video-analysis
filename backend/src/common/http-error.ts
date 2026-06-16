import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';

export function readableError(message: string, status = HttpStatus.BAD_REQUEST): HttpException {
  return new HttpException({ message }, status);
}

export function assertPlainObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException({ message });
  }
}
