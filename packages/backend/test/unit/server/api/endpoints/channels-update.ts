/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mocked } from 'vitest';
import type { ChannelsRepository, DriveFilesRepository, NotesRepository, UserNotePiningsRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import type { MiChannel } from '@/models/Channel.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { MiLocalUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import type { ChannelEntityService } from '@/core/entities/ChannelEntityService.js';
import type { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import type { HashtagService } from '@/core/HashtagService.js';
import type { NotePiningService } from '@/core/NotePiningService.js';
import type { RoleService } from '@/core/RoleService.js';
import ChannelsUpdateEndpoint from '@/server/api/endpoints/channels/update.js';

describe('channels/update', () => {
	const me = { id: 'ownerid' } as MiLocalUser;
	const channel = {
		id: 'channelid',
		userId: me.id,
		host: null,
		actorId: 'actorid',
		bannerId: null,
		pinnedNoteIds: [],
	} as unknown as MiChannel;
	const image = {
		id: 'fileid',
		userId: me.id,
		type: 'image/png',
		url: 'https://example.com/banner.png',
		blurhash: 'hash',
	} as MiDriveFile;
	const actor = {
		id: channel.actorId,
		username: 'channel',
	} as unknown as MiLocalUser;
	const copiedImage = {
		...image,
		id: 'copiedfileid',
		userId: channel.actorId,
	} as MiDriveFile;

	let channelsRepository: Mocked<ChannelsRepository>;
	let driveFilesRepository: Mocked<DriveFilesRepository>;
	let usersRepository: Mocked<UsersRepository>;
	let channelEntityService: Mocked<ChannelEntityService>;
	let driveFileEntityService: Mocked<DriveFileEntityService>;
	let roleService: Mocked<RoleService>;
	let userProfilesRepository: Mocked<UserProfilesRepository>;
	let notePiningService: Mocked<NotePiningService>;
	let endpoint: ChannelsUpdateEndpoint;

	beforeEach(() => {
		channelsRepository = {
			findOneBy: vi.fn().mockResolvedValue(channel),
			update: vi.fn().mockResolvedValue(undefined),
		} as unknown as Mocked<ChannelsRepository>;
		driveFilesRepository = {
			findOneBy: vi.fn().mockResolvedValue(image),
		} as unknown as Mocked<DriveFilesRepository>;
		usersRepository = {
			findOneBy: vi.fn().mockResolvedValue(actor),
			update: vi.fn().mockResolvedValue(undefined),
		} as unknown as Mocked<UsersRepository>;
		channelEntityService = {
			reuploadFileAsChannelAccount: vi.fn().mockResolvedValue(null),
			deleteChannelAccountFile: vi.fn().mockResolvedValue(undefined),
			pack: vi.fn().mockResolvedValue({ id: channel.id, bannerId: null }),
		} as unknown as Mocked<ChannelEntityService>;
		driveFileEntityService = {
			getPublicUrl: vi.fn().mockReturnValue(image.url),
		} as unknown as Mocked<DriveFileEntityService>;
		roleService = {
			isModerator: vi.fn().mockResolvedValue(false),
		} as unknown as Mocked<RoleService>;
		userProfilesRepository = {
			update: vi.fn().mockResolvedValue(undefined),
		} as unknown as Mocked<UserProfilesRepository>;
		notePiningService = {
			addPinned: vi.fn().mockResolvedValue(undefined),
			removePinned: vi.fn().mockResolvedValue(undefined),
		} as unknown as Mocked<NotePiningService>;

		endpoint = new ChannelsUpdateEndpoint(
			channelsRepository,
			driveFilesRepository,
			{ find: vi.fn().mockResolvedValue([{ id: 'newnoteid' }]) } as unknown as Mocked<NotesRepository>,
			usersRepository,
			{ find: vi.fn().mockResolvedValue([{ noteId: 'oldnoteid' }]) } as unknown as Mocked<UserNotePiningsRepository>,
			userProfilesRepository,
			channelEntityService,
			notePiningService,
			{ publishInternalEvent: vi.fn() } as unknown as Mocked<GlobalEventService>,
			{ updateUsertags: vi.fn() } as unknown as Mocked<HashtagService>,
			driveFileEntityService,
			roleService,
		);
	});

	function exec(bannerId: string | null) {
		return endpoint.exec({ channelId: channel.id, bannerId }, me, null, null);
	}

	test('rejects when the banner copy fails instead of reporting success', async () => {
		await expect(exec(image.id)).rejects.toMatchObject({
			code: 'BANNER_REUPLOAD_FAILED',
			kind: 'server',
			httpStatusCode: 500,
		});
		expect(channelsRepository.update).not.toHaveBeenCalled();
		expect(channelEntityService.pack).not.toHaveBeenCalled();
	});

	test('rejects a non-image banner instead of silently ignoring it', async () => {
		driveFilesRepository.findOneBy.mockResolvedValue({
			...image,
			type: 'text/plain',
		} as MiDriveFile);

		await expect(exec(image.id)).rejects.toMatchObject({
			code: 'BANNER_NOT_AN_IMAGE',
			httpStatusCode: 400,
		});
		expect(channelEntityService.reuploadFileAsChannelAccount).not.toHaveBeenCalled();
	});

	test('rejects when the icon copy fails instead of reporting success', async () => {
		await expect(endpoint.exec({ channelId: channel.id, iconId: image.id }, me, null, null)).rejects.toMatchObject({
			code: 'ICON_REUPLOAD_FAILED',
			kind: 'server',
			httpStatusCode: 500,
		});
		expect(channelsRepository.update).not.toHaveBeenCalled();
		expect(channelEntityService.pack).not.toHaveBeenCalled();
	});

	test('cleans up the copied banner when the icon copy fails', async () => {
		channelEntityService.reuploadFileAsChannelAccount
			.mockResolvedValueOnce(copiedImage)
			.mockResolvedValueOnce(null);

		await expect(endpoint.exec({ channelId: channel.id, bannerId: image.id, iconId: image.id }, me, null, null)).rejects.toMatchObject({
			code: 'ICON_REUPLOAD_FAILED',
		});
		expect(channelEntityService.deleteChannelAccountFile).toHaveBeenCalledWith(copiedImage.id, channel.actorId);
		expect(channelsRepository.update).not.toHaveBeenCalled();
		expect(channelEntityService.pack).not.toHaveBeenCalled();
	});

	test('returns the copied banner on success', async () => {
		channelEntityService.reuploadFileAsChannelAccount.mockResolvedValue(copiedImage);
		channelEntityService.pack.mockResolvedValue({
			id: channel.id,
			bannerId: copiedImage.id,
		} as Packed<'Channel'>);

		await expect(exec(image.id)).resolves.toMatchObject({
			bannerId: copiedImage.id,
		});
		expect(channelsRepository.update).toHaveBeenCalledWith(channel.id, expect.objectContaining({
			bannerId: copiedImage.id,
		}));
	});

	test('updates description and pins after successful image copies', async () => {
		channelEntityService.reuploadFileAsChannelAccount.mockResolvedValue(copiedImage);

		await endpoint.exec({
			channelId: channel.id,
			bannerId: image.id,
			iconId: image.id,
			description: 'Updated description',
			pinnedNoteIds: ['newnoteid'],
		}, me, null, null);

		expect(userProfilesRepository.update).toHaveBeenCalledWith({ userId: channel.actorId }, {
			description: 'Updated description',
		});
		expect(notePiningService.removePinned).toHaveBeenCalledWith({ id: channel.actorId, host: null }, 'oldnoteid', channel);
		expect(notePiningService.addPinned).toHaveBeenCalledWith({ id: channel.actorId, host: null }, 'newnoteid', channel);
		expect(channelsRepository.update).toHaveBeenCalledWith(channel.id, expect.objectContaining({
			bannerId: copiedImage.id,
			description: 'Updated description',
			pinnedNoteIds: ['newnoteid'],
		}));
		expect(channelEntityService.deleteChannelAccountFile).not.toHaveBeenCalled();
	});

	test.each([
		{ imageParams: { bannerId: image.id }, code: 'BANNER_REUPLOAD_FAILED' },
		{ imageParams: { iconId: image.id }, code: 'ICON_REUPLOAD_FAILED' },
		{ imageParams: { bannerId: image.id, iconId: image.id }, code: 'ICON_REUPLOAD_FAILED' },
	])('does not update description or pins when $code ($imageParams)', async ({ imageParams, code }) => {
		if (imageParams.bannerId && imageParams.iconId) {
			channelEntityService.reuploadFileAsChannelAccount.mockResolvedValueOnce(copiedImage);
		}

		await expect(endpoint.exec({
			channelId: channel.id,
			description: 'Updated description',
			pinnedNoteIds: ['newnoteid'],
			...imageParams,
		}, me, null, null)).rejects.toMatchObject({ code });

		expect(userProfilesRepository.update).not.toHaveBeenCalled();
		expect(notePiningService.addPinned).not.toHaveBeenCalled();
		expect(notePiningService.removePinned).not.toHaveBeenCalled();
		expect(usersRepository.update).not.toHaveBeenCalled();
		expect(channelsRepository.update).not.toHaveBeenCalled();
		expect(channelEntityService.pack).not.toHaveBeenCalled();
		if (imageParams.bannerId && imageParams.iconId) {
			expect(channelEntityService.deleteChannelAccountFile).toHaveBeenCalledWith(copiedImage.id, channel.actorId);
		}
	});
});
