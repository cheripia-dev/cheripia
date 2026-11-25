<!--
SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_panel" :class="$style.game">
	<div :class="$style.gameHeader">
		<span>{{ matchLengthLabels[game.matchLength] }}</span>
		<span v-if="game.endReason === 'tobi'" :class="$style.tobiBadge">{{ i18n.ts._mahjong.tobiEnd }}</span>
		<MkTime :class="$style.gameTime" :time="game.endedAt"/>
	</div>
	<div :class="$style.gameSeats" role="list">
		<div v-for="seat in gameSeats" :key="seat.rank" :class="$style.gameSeat" role="listitem">
			<span :class="[seat.rank === 1 ? $style.gameSeatRank1 : $style.gameSeatRank]">{{ seat.rank }}</span>
			<MkAvatar v-if="seat.user != null" :user="seat.user" :class="$style.gameSeatAvatar"/>
			<span :class="$style.gameSeatName">
				<b v-if="seat.user != null"><MkUserName :user="seat.user"/></b>
				<span v-else-if="seat.ai">{{ i18n.ts._mahjong.cpu }}</span>
				<span v-else>{{ i18n.ts.deletedUser }}</span>
			</span>
			<span :class="$style.gameSeatPoints">{{ seat.points }}</span>
		</div>
	</div>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type * as Misskey from 'misskey-js';
import { i18n } from '@/i18n.js';
import { getMatchLengthLabels } from './match-length-labels.js';

const props = defineProps<{
	game: Misskey.entities.MahjongGameRecord;
}>();

const matchLengthLabels = getMatchLengthLabels();

type GameSeat = {
	rank: number;
	points: number;
	ai: boolean;
	user: Misskey.entities.UserLite | null;
};

const gameSeats = computed<GameSeat[]>(() => {
	const game = props.game;
	return [
		{ rank: game.user1Rank, points: game.user1Points, ai: game.user1Ai, user: game.user1 },
		{ rank: game.user2Rank, points: game.user2Points, ai: game.user2Ai, user: game.user2 },
		{ rank: game.user3Rank, points: game.user3Points, ai: game.user3Ai, user: game.user3 },
		{ rank: game.user4Rank, points: game.user4Points, ai: game.user4Ai, user: game.user4 },
	].sort((a, b) => a.rank - b.rank);
});
</script>

<style lang="scss" module>
.game {
	padding: 12px;
	border-radius: var(--MI-radius);
}

.gameHeader {
	display: flex;
	align-items: baseline;
	gap: 8px;
	margin-bottom: 8px;
	font-size: 90%;
	font-weight: bold;
}

.gameTime {
	margin-left: auto;
	opacity: 0.7;
}

.tobiBadge {
	padding: 0 8px;
	border-radius: 999px;
	background: var(--MI_THEME-infoWarnBg);
	color: var(--MI_THEME-infoWarnFg);
	font-size: 80%;
	font-weight: bold;
}

.gameSeats {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.gameSeat {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 90%;
}

.gameSeatRank {
	width: 1.5em;
	flex-shrink: 0;
	text-align: center;
	opacity: 0.7;
}

.gameSeatRank1 {
	width: 1.5em;
	flex-shrink: 0;
	text-align: center;
	color: var(--MI_THEME-accent);
	font-weight: bold;
}

.gameSeatAvatar {
	width: 24px;
	height: 24px;
	flex-shrink: 0;
}

.gameSeatName {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.gameSeatPoints {
	flex-shrink: 0;
	font-variant-numeric: tabular-nums;
}
</style>
