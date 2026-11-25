/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Misskey from 'misskey-js';
import { i18n } from '@/i18n.js';

export type MatchLength = Misskey.entities.MahjongRoomDetailed['matchLength'];

export function getMatchLengthLabels(): Record<MatchLength, string> {
	return {
		single: i18n.ts._mahjong.singleMatch,
		east: i18n.ts._mahjong.eastMatch,
		south: i18n.ts._mahjong.southMatch,
	};
}
