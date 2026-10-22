/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { MediaProcessor } from '@cheripia-dev/media-proxy-napi';
import { bindThis } from '@/decorators.js';
import type { MediaProcessorOptions, ProcessOptions } from '@cheripia-dev/media-proxy-napi';
import type { Readable } from 'node:stream';

export type IImage = {
	data: Buffer;
	ext: string | null;
	type: string;
};

export type IImageStream = {
	data: Readable;
	ext: string | null;
	type: string;
};

export type IImageStreamable = IImage | IImageStream;

const DEFAULT_MAX_PIXELS = 2048;
const DEFAULT_WEBP_QUALITY = 77;

/**
 * media-proxy-napi には「リサイズしない」オプションが無いため、
 * 実用上リサイズされない napi の許容最大値を noResize 用として使う。
 */
const NO_RESIZE_MAX_PIXELS = 16383;

@Injectable()
export class ImageProcessingService implements OnModuleInit {
	private readonly processor: MediaProcessor;
	private readonly noResizeProcessor: MediaProcessor;

	constructor() {
		const options: MediaProcessorOptions = {
			loadSystemFonts: true,
		};
		this.processor = new MediaProcessor({ ...options, maxPixels: DEFAULT_MAX_PIXELS });
		this.noResizeProcessor = new MediaProcessor({ ...options, maxPixels: NO_RESIZE_MAX_PIXELS });
	}

	@bindThis
	public async onModuleInit(): Promise<void> {
		await Promise.all([
			this.processor.preloadFonts(),
			this.noResizeProcessor.preloadFonts(),
		]);
	}

	@bindThis
	public async process(src: Buffer, options: ProcessOptions = {}): Promise<IImage> {
		return await this.convert(this.processor, src, options);
	}

	@bindThis
	public async processWithoutResize(src: Buffer, options: ProcessOptions = {}): Promise<IImage> {
		return await this.convert(this.noResizeProcessor, src, options);
	}

	@bindThis
	public async processFile(path: string, options: ProcessOptions = {}): Promise<IImage> {
		return await this.process(await fs.promises.readFile(path), options);
	}

	private async convert(processor: MediaProcessor, src: Buffer, options: ProcessOptions): Promise<IImage> {
		const result = await processor.process(src, { webpQuality: DEFAULT_WEBP_QUALITY, ...options });

		return {
			data: result.data,
			// napi は ".webp" のようにドット付きで返すため、IImage の規約 (ドット無し) に合わせる
			ext: result.ext.startsWith('.') ? result.ext.slice(1) : result.ext,
			type: result.contentType,
		};
	}
}
