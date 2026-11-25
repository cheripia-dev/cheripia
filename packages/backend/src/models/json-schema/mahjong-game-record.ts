/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const packedMahjongGameRecordSchema = {
	type: 'object',
	properties: {
		id: {
			type: 'string',
			optional: false, nullable: false,
			format: 'id',
		},
		startedAt: {
			type: 'string',
			optional: false, nullable: false,
			format: 'date-time',
		},
		endedAt: {
			type: 'string',
			optional: false, nullable: false,
			format: 'date-time',
		},
		matchLength: {
			type: 'string',
			optional: false, nullable: false,
			enum: ['single', 'east', 'south'],
		},
		endReason: {
			type: 'string',
			optional: false, nullable: false,
			enum: ['normal', 'tobi'],
		},
		timeLimitForEachTurn: {
			type: 'number',
			optional: false, nullable: false,
		},
		user1Id: {
			type: 'string',
			optional: false, nullable: true,
			format: 'id',
		},
		user1: {
			type: 'object',
			optional: false, nullable: true,
			ref: 'UserLite',
		},
		user1Ai: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		user1Points: {
			type: 'number',
			optional: false, nullable: false,
		},
		user1Rank: {
			type: 'number',
			optional: false, nullable: false,
		},
		user2Id: {
			type: 'string',
			optional: false, nullable: true,
			format: 'id',
		},
		user2: {
			type: 'object',
			optional: false, nullable: true,
			ref: 'UserLite',
		},
		user2Ai: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		user2Points: {
			type: 'number',
			optional: false, nullable: false,
		},
		user2Rank: {
			type: 'number',
			optional: false, nullable: false,
		},
		user3Id: {
			type: 'string',
			optional: false, nullable: true,
			format: 'id',
		},
		user3: {
			type: 'object',
			optional: false, nullable: true,
			ref: 'UserLite',
		},
		user3Ai: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		user3Points: {
			type: 'number',
			optional: false, nullable: false,
		},
		user3Rank: {
			type: 'number',
			optional: false, nullable: false,
		},
		user4Id: {
			type: 'string',
			optional: false, nullable: true,
			format: 'id',
		},
		user4: {
			type: 'object',
			optional: false, nullable: true,
			ref: 'UserLite',
		},
		user4Ai: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		user4Points: {
			type: 'number',
			optional: false, nullable: false,
		},
		user4Rank: {
			type: 'number',
			optional: false, nullable: false,
		},
	},
} as const;
