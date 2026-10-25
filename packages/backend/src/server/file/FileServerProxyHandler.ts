/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import type { Config } from '@/config.js';
import { FILE_TYPE_BROWSERSAFE } from '@/const.js';
import { StatusError } from '@/misc/status-error.js';
import { contentDisposition } from '@/misc/content-disposition.js';
import { correctFilename } from '@/misc/correct-filename.js';
import type { IImageStreamable } from '@/core/ImageProcessingService.js';
import { ImageProcessingService } from '@/core/ImageProcessingService.js';
import { createRangeStream, attachStreamCleanup, needsCleanup } from './FileServerUtils.js';
import type { ProcessOptions } from '@cheripia-dev/media-proxy-napi';
import type { DownloadedFileResult, FileResolveResult, FileServerFileResolver } from './FileServerFileResolver.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

const MEDIA_PROCESSOR_ERROR_CODES = new Set<string>([
	'Unsupported',
	'DecodeLimit',
	'Decode',
	'Encode',
	'BadgeSkipped',
	'Overloaded',
	'Timeout',
	'Internal',
]);

type ProxySource = DownloadedFileResult | FileResolveResult;
type CleanupableFile = ProxySource & { cleanup: () => void };
type AvailableFile = Exclude<ProxySource, { kind: 'not-found' | 'unavailable' }>;
type ProxyQuery = {
	emoji?: string;
	avatar?: string;
	static?: string;
	preview?: string;
	badge?: string;
	origin?: string;
	url?: string;
};

export class FileServerProxyHandler {
	constructor(
		private config: Config,
		private fileResolver: FileServerFileResolver,
		private assetsPath: string,
		private imageProcessingService: ImageProcessingService,
	) {}

	public async handle(request: FastifyRequest<{ Params: { url: string }; Querystring: ProxyQuery }>, reply: FastifyReply) {
		const url = 'url' in request.query ? request.query.url : 'https://' + request.params.url;

		if (typeof url !== 'string') {
			reply.code(400);
			return;
		}

		// アバタークロップなど、どうしてもオリジンである必要がある場合
		const mustOrigin = 'origin' in request.query;

		if (this.config.externalMediaProxyEnabled && !mustOrigin) {
			return await this.redirectToExternalProxy(request, reply);
		}

		this.validateUserAgent(request);

		// Create temp file
		const file = await this.getStreamAndTypeFromUrl(url);
		if (file.kind === 'not-found') {
			reply.code(404);
			reply.header('Cache-Control', 'max-age=86400');
			return reply.sendFile('/dummy.png', this.assetsPath);
		}

		if (file.kind === 'unavailable') {
			reply.code(204);
			reply.header('Cache-Control', 'max-age=86400');
			return;
		}

		try {
			const image = await this.processImage(file, request, reply);

			if (needsCleanup(file)) {
				attachStreamCleanup(image.data, file.cleanup);
			}

			reply.header('Content-Type', image.type);
			reply.header('Cache-Control', 'max-age=31536000, immutable');
			reply.header('Content-Disposition',
				contentDisposition(
					'inline',
					correctFilename(file.filename, image.ext),
				),
			);
			return image.data;
		} catch (e) {
			if (needsCleanup(file)) file.cleanup();
			throw e;
		}
	}

	/**
	 * 外部メディアプロキシにリダイレクトする
	 */
	private async redirectToExternalProxy(
		request: FastifyRequest<{ Params: { url: string }; Querystring: ProxyQuery }>,
		reply: FastifyReply,
	) {
		reply.header('Cache-Control', 'public, max-age=259200'); // 3 days

		const url = new URL(`${this.config.mediaProxy}/${request.params.url || ''}`);

		for (const [key, value] of Object.entries(request.query)) {
			url.searchParams.append(key, value);
		}

		return reply.redirect(url.toString(), 301);
	}

	/**
	 * User-Agent を検証する
	 */
	private validateUserAgent(request: FastifyRequest): void {
		if (!request.headers['user-agent']) {
			throw new StatusError('User-Agent is required', 400, 'User-Agent is required');
		}
		if (request.headers['user-agent'].toLowerCase().indexOf('cheripia/') !== -1) {
			throw new StatusError('Refusing to proxy a request from another proxy', 403, 'Proxy is recursive');
		}
	}

	/**
	 * 画像を処理してストリーム可能な形式に変換する
	 */
	private async processImage(
		file: AvailableFile,
		request: FastifyRequest<{ Params: { url: string }; Querystring: ProxyQuery }>,
		reply: FastifyReply,
	): Promise<IImageStreamable> {
		const query = request.query;

		const options: ProcessOptions = {
			emoji: 'emoji' in query,
			avatar: 'avatar' in query,
			static: 'static' in query,
			preview: 'preview' in query,
			badge: 'badge' in query,
		};

		// preview は先頭フレームのみの静止画を返す従来動作を保つ。
		// napi では static プリセットが preview より優先されて寸法が変わるため、
		// 従来の 200x200 収まるサイズを明示する。
		if (options.preview) {
			options.static = true;
			options.width = 200;
			options.height = 200;
		}

		const requiresImageConversion = options.emoji || options.avatar || options.static || options.preview || options.badge;

		if (!requiresImageConversion && file.mime !== 'image/svg+xml') {
			if (!file.mime.startsWith('image/') || !FILE_TYPE_BROWSERSAFE.includes(file.mime)) {
				throw new StatusError('Rejected type', 403, 'Rejected type');
			}

			return this.createDefaultStream(file, request, reply);
		}

		try {
			return await this.imageProcessingService.processFile(file.path, {
				...options,
				contentType: file.mime,
			});
		} catch (e) {
			throw this.translateImageProcessingError(e);
		}
	}

	private translateImageProcessingError(error: unknown): Error {
		if (!(error instanceof Error)) return new Error(String(error));

		const code = (error as Error & { code?: unknown }).code;
		if (typeof code !== 'string' || !MEDIA_PROCESSOR_ERROR_CODES.has(code)) return error;

		switch (code) {
			case 'BadgeSkipped':
				return new StatusError('Skip to provide badge', 404);
			case 'Unsupported':
				return new StatusError('Unexpected mime', 404, 'Unexpected mime');
			default:
				return new StatusError(`Image processing failed (${code})`, 502, code);
		}
	}

	/**
	 * デフォルトのストリームを作成する（Range リクエスト対応）
	 */
	private createDefaultStream(
		file: AvailableFile,
		request: FastifyRequest,
		reply: FastifyReply,
	): IImageStreamable {
		if (request.headers.range && 'file' in file && file.file.size > 0) {
			const { stream, start, end, chunksize } = createRangeStream(request.headers.range as string, file.file.size, file.path);

			reply.header('Content-Range', `bytes ${start}-${end}/${file.file.size}`);
			reply.header('Accept-Ranges', 'bytes');
			reply.header('Content-Length', chunksize);
			reply.code(206);

			return {
				data: stream,
				ext: file.ext,
				type: file.mime,
			};
		}

		return {
			data: fs.createReadStream(file.path),
			ext: file.ext,
			type: file.mime,
		};
	}

	private async getStreamAndTypeFromUrl(url: string): Promise<ProxySource> {
		if (url.startsWith(`${this.config.url}/files/`)) {
			const key = url.replace(`${this.config.url}/files/`, '').split('/').shift();
			if (!key) throw new StatusError('Invalid File Key', 400, 'Invalid File Key');

			return await this.fileResolver.resolveFileByAccessKey(key);
		}

		return await this.fileResolver.downloadAndDetectTypeFromUrl(url);
	}
}
