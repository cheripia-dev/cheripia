/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Brackets } from 'typeorm';

/**
 * 「フォローしているユーザーのチャンネル投稿をTLに含める」設定に基づく、チャンネル投稿のHTL可否を判定する。
 * 自分のチャンネル投稿は設定に関係なく通す。
 * （REST の noteFilter とストリーム両方で共有する。REST 側は設定を切った後に Redis へ残っている古いチャンネル投稿の除外もここで行う）
 *
 * @param note 確認対象のノート
 * @param meId タイムラインの閲覧者ID
 * @param includeChannelPostsInTimeline 閲覧者の「フォローしているユーザーのチャンネル投稿をTLに含める」設定
 * @param followingChannels 閲覧者がフォローしているチャンネルIDの集合
 * @param followings 閲覧者がフォローしているユーザーの一覧（キーがユーザーID）
 */
export function isChannelPostAllowedForMe(
	note: { userId: string, channelId?: string | null },
	meId: string,
	includeChannelPostsInTimeline: boolean,
	followingChannels: Set<string>,
	followings: Record<string, unknown>,
): boolean {
	if (note.channelId != null && !followingChannels.has(note.channelId)) {
		if (note.userId !== meId && !(includeChannelPostsInTimeline && Object.hasOwn(followings, note.userId))) return false;
	}
	return true;
}

/**
 * 指定ユーザーによるチャンネル投稿（ミュート済みチャンネルを除く）を表すSQL条件を返す。
 * userIdsが空のときは不正SQLを防ぐため、何もマッチしない条件を返す。
 * 注意: 同一クエリ内でこの関数を2回呼ぶと `:userIds` パラメータが共有され上書きされるため、
 * 呼び出しは1回に統合し、必要なユーザーIDをまとめて渡すこと。
 */
export function channelPostsOf(userIds: string[], mutingChannelIds: string[]): Brackets {
	return new Brackets(qb2 => {
		if (userIds.length === 0) {
			qb2.andWhere('1=0');
			return;
		}
		qb2
			.andWhere('note.userId IN (:...userIds)', { userIds })
			.andWhere('note.channelId IS NOT NULL');
		if (mutingChannelIds.length > 0) {
			qb2.andWhere('note.channelId NOT IN (:...mutingChannelIds)', { mutingChannelIds });
		}
	});
}

/**
 * 自分の投稿（ミュート済みチャンネルへの投稿とそのリノートを除く）を表すSQL条件を返す。
 * 自分のチャンネル投稿は設定に関係なく常時含めるが、ミュート済みチャンネルは除く。
 */
export function myPostsExcludingMutedChannels(meId: string, mutingChannelIds: string[]): Brackets {
	return new Brackets(qb2 => {
		qb2.where('note.userId = :meId', { meId });
		if (mutingChannelIds.length > 0) {
			qb2.andWhere(new Brackets(qb3 => {
				qb3.orWhere('note.channelId IS NULL');
				qb3.orWhere('note.channelId NOT IN (:...mutingChannelIds)', { mutingChannelIds });
			}));
			qb2.andWhere(new Brackets(qb3 => {
				qb3.orWhere('note.renoteChannelId IS NULL');
				qb3.orWhere('note.renoteChannelId NOT IN (:...mutingChannelIds)', { mutingChannelIds });
			}));
		}
	});
}
