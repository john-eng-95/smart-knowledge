import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { extname } from 'path';

export interface UploadBytesOptions {
  fileName: string;
  contentType: string;
  /** Object key prefix; defaults to documents. */
  prefix?: string;
}

/** RustFS file storage (S3-compatible). */
@Injectable()
export class RustfsService implements OnModuleInit {
  private readonly logger = new Logger(RustfsService.name);
  private client: S3Client | null = null;
  private enabled = false;
  private bucket = '';
  private publicBaseUrl = '';

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.enabled =
      this.config.get<string>('RUSTFS_ENABLED', 'true').toLowerCase() !==
      'false';

    if (!this.enabled) {
      this.logger.warn(
        'RustFS is disabled (RUSTFS_ENABLED=false); file uploads will be skipped',
      );
      return;
    }

    const endpoint = this.config.get<string>(
      'RUSTFS_ENDPOINT',
      'http://localhost:9000',
    );
    const accessKey = this.config.get<string>('RUSTFS_ACCESS_KEY', 'localdev');
    const secretKey = this.config.get<string>(
      'RUSTFS_SECRET_KEY',
      'local-only-rustfs-secret',
    );
    const region = this.config.get<string>('RUSTFS_REGION', 'us-east-1');
    this.bucket = this.config.get<string>('RUSTFS_BUCKET', 'knowledge-hub');
    this.publicBaseUrl = (
      this.config.get<string>('RUSTFS_PUBLIC_URL') || endpoint
    ).replace(/\/$/, '');

    this.client = new S3Client({
      endpoint,
      region,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      forcePathStyle: true,
    });

    this.logger.log(
      `RustFS configured: endpoint=${endpoint}, bucket=${this.bucket}, public=${this.publicBaseUrl}`,
    );

    void this.ensureBucket().catch((err) => {
      this.logger.warn(
        `RustFS bucket initialization failed (will retry on first upload): ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  isEnabled(): boolean {
    return this.enabled && this.client != null;
  }

  /** Upload bytes and return an accessible URL: {publicBase}/{bucket}/{key}. */
  async uploadBytes(
    bytes: Buffer | Uint8Array,
    options: UploadBytesOptions,
  ): Promise<string> {
    if (!this.isEnabled() || !this.client) {
      throw new ServiceUnavailableException(
        'RustFS is disabled or not configured; unable to upload the file',
      );
    }

    await this.ensureBucket();

    const prefix = (options.prefix ?? 'documents').replace(/^\/+|\/+$/g, '');
    const ext = extname(options.fileName) || guessExt(options.contentType);
    const safeBase = sanitizeBaseName(options.fileName);
    const key = `${prefix}/${formatDatePath()}/${safeBase}-${randomUUID()}${ext}`;
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ContentLength: body.length,
      }),
    );

    const url = `${this.publicBaseUrl}/${this.bucket}/${key}`;
    this.logger.log(
      `RustFS upload succeeded: key=${key}, size=${body.length}, url=${url}`,
    );
    return url;
  }

  private async ensureBucket(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch {
      // Create the bucket when it does not exist.
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`RustFS bucket created: ${this.bucket}`);
    } catch (err) {
      // A concurrent creator may have created it already.
      const message = err instanceof Error ? err.message : String(err);
      if (
        !/BucketAlreadyOwnedByYou|BucketAlreadyExists|already exists/i.test(
          message,
        )
      ) {
        throw err;
      }
    }
  }
}

function formatDatePath(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

function sanitizeBaseName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '') || 'file';
  return base.replace(/[^\w\u4e00-\u9fff.-]+/g, '_').slice(0, 64);
}

function guessExt(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'application/pdf':
      return '.pdf';
    default:
      return '';
  }
}
