<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkStickyContainer>
	<MkSpacer :contentMax="600">
		<div class="_gaps">
			<div class="_panel" style="padding: 16px;">
				<div style="font-size: 90%; opacity: 0.8; margin-bottom: 8px;">
					{{ room.isInviteOnly ? i18n.ts._mahjong.inviteOnlyShareUrlHint : i18n.ts._mahjong.shareUrlHint }}
				</div>
				<div style="display: flex; gap: 8px; align-items: center;">
					<code style="flex: 1; overflow: hidden; text-overflow: ellipsis;">{{ roomUrl }}</code>
					<MkButton small @click="copyUrl">コピー</MkButton>
				</div>
			</div>

			<div class="_panel _gaps" style="padding: 16px;">
				<div v-for="index in [1, 2, 3, 4]" :key="index" :class="$style.seat">
					<template v-if="seatUser(index) != null">
						<MkAvatar :user="seatUser(index)!" :class="$style.seatAvatar"/>
						<span :class="$style.seatName">{{ seatUser(index)!.name ?? seatUser(index)!.username }}</span>
					</template>
					<template v-else-if="seatAi(index)">
						<span :class="[$style.seatBadge, $style.seatCpu]">CPU</span>
					</template>
					<template v-else>
						<span :class="[$style.seatBadge, $style.seatEmpty]">空席</span>
					</template>
					<div style="margin-left: auto; display: flex; align-items: center; gap: 8px;">
						<span v-if="seatReady(index)" style="color: var(--MI_THEME-success);">準備完了</span>
						<MkButton v-if="isOwner && !room.isStarted && !room.isEnded && seatAi(index)" small danger @click="removeCpu(index)">削除</MkButton>
						<MkButton v-if="canKick(index)" small danger @click="kick(index)">{{ i18n.ts._mahjong.kick }}</MkButton>
					</div>
				</div>
				<div v-if="!isOwner || room.isStarted || room.isEnded" style="margin-top: 8px; font-size: 90%; opacity: 0.8;">
					持ち時間: {{ room.timeLimitForEachTurn }}秒
				</div>
				<div v-if="isOwner && !room.isStarted && !room.isEnded" style="margin-top: 8px;">
					<MkInput v-model="timeLimit" type="number" :min="5" :max="300" :step="1">
						<template #label>{{ i18n.ts._reversi.timeLimitForEachTurn }}</template>
						<template #suffix>{{ i18n.ts._time.second }}</template>
					</MkInput>
				</div>
				<div style="margin-top: 8px; font-size: 90%; opacity: 0.8;">
					{{ i18n.ts._mahjong.matchLength }}: {{ matchLengthLabel }}
				</div>
				<div v-if="isOwner && !room.isStarted && !room.isEnded" style="margin-top: 8px;">
					<MkRadios v-model="matchLength" :options="matchLengthOptions"/>
				</div>
				<div style="margin-top: 8px; font-size: 90%; opacity: 0.8;">
					{{ i18n.ts._mahjong.inviteOnly }}: {{ room.isInviteOnly ? i18n.ts.yes : i18n.ts.no }}
				</div>
				<div v-if="isOwner && !room.isStarted && !room.isEnded" style="margin-top: 8px;">
					<MkSwitch v-model="inviteOnly">{{ i18n.ts._mahjong.inviteOnlyDescription }}</MkSwitch>
				</div>
			</div>

			<div v-if="room.invitations.length > 0" class="_panel" style="padding: 16px;">
				<div style="font-size: 90%; opacity: 0.8;">{{ i18n.ts._mahjong.invitedUsers }}</div>
				<div v-for="invitation in room.invitations" :key="invitation.userId" :class="$style.seat">
					<MkAvatar v-if="invitation.user" :user="invitation.user" :class="$style.seatAvatar"/>
					<span :class="$style.seatName">{{ invitationName(invitation) }}</span>
					<div style="margin-left: auto; display: flex; align-items: center; gap: 8px;">
						<MkButton v-if="canCancelInvitation(invitation)" small danger @click="cancelInvite(invitation)">{{ i18n.ts._mahjong.cancelInvite }}</MkButton>
					</div>
				</div>
			</div>

			<div class="_buttonsCenter">
				<MkButton v-if="canInvite" rounded primary @click="invite">{{ i18n.ts._mahjong.invite }}</MkButton>
				<MkButton v-if="isOwner" rounded @click="addCpu">{{ i18n.ts._mahjong.addCpu }}</MkButton>
			</div>
		</div>
	</MkSpacer>
	<template #footer>
		<div :class="$style.footer">
			<MkSpacer :contentMax="700" :marginMin="16" :marginMax="16">
				<div style="text-align: center;" class="_gaps_s">
					<div class="_buttonsCenter">
						<MkButton rounded danger @click="leave">{{ i18n.ts._mahjong.leave }}</MkButton>
						<MkButton v-if="!isReady" rounded primary @click="ready">{{ i18n.ts._mahjong.ready }}</MkButton>
						<MkButton v-if="isReady" rounded @click="unready">{{ i18n.ts._mahjong.cancelReady }}</MkButton>
					</div>
				</div>
			</MkSpacer>
		</div>
	</template>
</MkStickyContainer>
</template>

<script lang="ts" setup>
import { computed, ref, onUnmounted, watch } from 'vue';
import * as Misskey from 'misskey-js';
import { url } from '@@/js/config.js';
import { i18n } from '@/i18n.js';
import { ensureSignin } from '@/i.js';
import { deepClone } from '@/utility/clone.js';
import { copyToClipboard } from '@/utility/copy-to-clipboard.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import type { MkRadiosOption } from '@/components/MkRadios.vue';
import MkButton from '@/components/MkButton.vue';
import MkInput from '@/components/MkInput.vue';
import MkRadios from '@/components/MkRadios.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import * as os from '@/os.js';
import { useRouter } from '@/router.js';

const $i = ensureSignin();

const props = defineProps<{
	room: Misskey.entities.MahjongRoomDetailed;
	connection: Misskey.IChannelConnection<Misskey.Channels['mahjongRoom']>;
}>();

const router = useRouter();

const room = ref<Misskey.entities.MahjongRoomDetailed>(deepClone(props.room));

const timeLimit = ref<number>(room.value.timeLimitForEachTurn);

watch(timeLimit, () => {
	const value = Math.floor(Number(timeLimit.value));
	if (!Number.isInteger(value) || value < 5 || value > 300) return;
	if (value === room.value.timeLimitForEachTurn) return;
	room.value.timeLimitForEachTurn = value;
	props.connection.send('updateSettings', {
		key: 'timeLimitForEachTurn',
		value,
	});
});

type MatchLength = Misskey.entities.MahjongRoomDetailed['matchLength'];

const matchLength = ref<MatchLength>(room.value.matchLength ?? 'south');

// 対局形式の value → ラベル。選択肢と現在の表示ラベルの単一の出し所にする
const matchLengthLabels: Record<MatchLength, string> = {
	single: i18n.ts._mahjong.singleMatch,
	east: i18n.ts._mahjong.eastMatch,
	south: i18n.ts._mahjong.southMatch,
};

const matchLengthOptions = (Object.keys(matchLengthLabels) as MatchLength[])
	.map(value => ({ value, label: matchLengthLabels[value] })) satisfies MkRadiosOption<MatchLength>[];

const matchLengthLabel = computed(() => matchLengthLabels[room.value.matchLength]);

watch(matchLength, () => {
	if (matchLength.value === room.value.matchLength) return;
	room.value.matchLength = matchLength.value;
	props.connection.send('updateSettings', {
		key: 'matchLength',
		value: matchLength.value,
	});
});

const inviteOnly = ref<boolean>(room.value.isInviteOnly);

watch(inviteOnly, () => {
	if (inviteOnly.value === room.value.isInviteOnly) return;
	room.value.isInviteOnly = inviteOnly.value;
	props.connection.send('updateSettings', {
		key: 'isInviteOnly',
		value: inviteOnly.value,
	});
});

const roomUrl = computed(() => `${url}/mahjong/g/${room.value.id}`);
const isOwner = computed(() => room.value.user1Id === $i.id);

const isMember = computed(() => [
	room.value.user1Id,
	room.value.user2Id,
	room.value.user3Id,
	room.value.user4Id,
].includes($i.id));

/** 対局開始前で、ルームの参加者なら招待できる */
const canInvite = computed(() => isMember.value && !room.value.isStarted && !room.value.isEnded);

const isReady = computed(() => {
	if (room.value.user1Id === $i.id && room.value.user1Ready) return true;
	if (room.value.user2Id === $i.id && room.value.user2Ready) return true;
	if (room.value.user3Id === $i.id && room.value.user3Ready) return true;
	if (room.value.user4Id === $i.id && room.value.user4Ready) return true;
	return false;
});

function seatUser(index: number): Misskey.entities.UserLite | null {
	switch (index) {
		case 1: return room.value.user1;
		case 2: return room.value.user2;
		case 3: return room.value.user3;
		case 4: return room.value.user4;
		default: return null;
	}
}

function seatAi(index: number): boolean {
	switch (index) {
		case 1: return room.value.user1Ai;
		case 2: return room.value.user2Ai;
		case 3: return room.value.user3Ai;
		case 4: return room.value.user4Ai;
		default: return false;
	}
}

function seatReady(index: number): boolean {
	switch (index) {
		case 1: return room.value.user1Ready;
		case 2: return room.value.user2Ready;
		case 3: return room.value.user3Ready;
		case 4: return room.value.user4Ready;
		default: return false;
	}
}

async function copyUrl() {
	await copyToClipboard(roomUrl.value);
	os.success();
}

async function leave() {
	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.ts.areYouSure,
	});
	if (canceled) return;

	props.connection.send('leave', {});
	router.push('/mahjong');
}

function ready() {
	props.connection.send('ready', true);
}

function unready() {
	props.connection.send('ready', false);
}

function addCpu() {
	props.connection.send('addAi', {});
}

function removeCpu(index: number) {
	props.connection.send('removeAi', { index });
}

function canKick(index: number): boolean {
	if (!isOwner.value) return false;
	if (room.value.isStarted || room.value.isEnded) return false;
	const user = seatUser(index);
	// 部屋主自身の席とCPU席は対象外 (CPU席は「削除」で消す)
	return user != null && user.id !== $i.id;
}

async function kick(index: number) {
	const user = seatUser(index);
	if (user == null) return;

	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.tsx._mahjong.kickConfirm({ name: user.name ?? user.username }),
	});
	if (canceled) return;

	props.connection.send('kick', { index });
}

type Invitation = Misskey.entities.MahjongRoomDetailed['invitations'][number];

/** 招待された人の表示名 (パック済みのユーザーが無い場合はIDで返す) */
function invitationName(invitation: Invitation): string {
	return invitation.user?.name ?? invitation.user?.username ?? invitation.userId;
}

// 招待のAPIが返すエラーコードとメッセージの対応
const inviteErrorMessages: Record<string, string> = {
	ALREADY_INVITED: i18n.ts._mahjong.alreadyInvited,
	CANNOT_INVITE: i18n.ts._mahjong.cannotInvite,
	NOT_LOCAL_USER: i18n.ts._mahjong.notLocalUser,
	ROOM_FULL: i18n.ts._mahjong.roomFull,
	GAME_STARTED: i18n.ts._mahjong.gameStarted,
	NOT_MEMBER: i18n.ts._mahjong.notMember,
	NO_SUCH_ROOM: i18n.ts._mahjong.noSuchRoom,
	NO_SUCH_USER: i18n.ts.noSuchUser,
	NO_SUCH_INVITATION: i18n.ts._mahjong.noSuchInvitation,
};

async function showApiError(err: unknown): Promise<void> {
	const apiError = err as { code?: string; message?: string };
	await os.alert({
		type: 'error',
		text: (apiError.code != null ? inviteErrorMessages[apiError.code] : null) ?? i18n.ts._mahjong.inviteFailed,
	});
}

function canCancelInvitation(invitation: Invitation): boolean {
	if (!canInvite.value) return false;
	return invitation.inviterId === $i.id || isOwner.value;
}

async function invite() {
	const user = await os.selectUser({ includeSelf: false, localOnly: true });

	try {
		room.value = await misskeyApi('mahjong/invite', {
			roomId: room.value.id,
			userId: user.id,
		});
		inviteOnly.value = room.value.isInviteOnly;
		os.success();
	} catch (err) {
		await showApiError(err);
	}
}

async function cancelInvite(invitation: Invitation) {
	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.tsx._mahjong.cancelInviteConfirm({ name: invitationName(invitation) }),
	});
	if (canceled) return;

	try {
		room.value = await misskeyApi('mahjong/cancel-invite', {
			roomId: room.value.id,
			userId: invitation.userId,
		});
		inviteOnly.value = room.value.isInviteOnly;
		os.success();
	} catch (err) {
		await showApiError(err);
	}
}

function onChangeReadyStates(states: {
	user1: boolean;
	user2: boolean;
	user3: boolean;
	user4: boolean;
}) {
	room.value.user1Ready = states.user1;
	room.value.user2Ready = states.user2;
	room.value.user3Ready = states.user3;
	room.value.user4Ready = states.user4;
}

function onJoined(x: {
	index: number;
	user: Misskey.entities.UserLite | null;
}) {
	switch (x.index) {
		case 1:
			room.value.user1 = x.user;
			room.value.user1Ai = x.user == null;
			break;
		case 2:
			room.value.user2 = x.user;
			room.value.user2Ai = x.user == null;
			break;
		case 3:
			room.value.user3 = x.user;
			room.value.user3Ai = x.user == null;
			break;
		case 4:
			room.value.user4 = x.user;
			room.value.user4Ai = x.user == null;
			break;
	}
}

function onLeft(x: { index: number }) {
	switch (x.index) {
		case 1:
			room.value.user1 = null;
			break;
		case 2:
			room.value.user2 = null;
			room.value.user2Ai = false;
			room.value.user2Ready = false;
			break;
		case 3:
			room.value.user3 = null;
			room.value.user3Ai = false;
			room.value.user3Ready = false;
			break;
		case 4:
			room.value.user4 = null;
			room.value.user4Ai = false;
			room.value.user4Ready = false;
			break;
	}
}

function onInvited(x: {
	user: Misskey.entities.UserLite;
	inviterId: string;
}) {
	if (room.value.invitations.some(invitation => invitation.userId === x.user.id)) return;
	room.value.invitations = [...room.value.invitations, {
		userId: x.user.id,
		inviterId: x.inviterId,
		user: x.user,
	}];
}

function onInvitationCanceled(x: { userId: string }) {
	room.value.invitations = room.value.invitations.filter(invitation => invitation.userId !== x.userId);
}

function onInviteOnlyChanged(x: { isInviteOnly: boolean }) {
	room.value.isInviteOnly = x.isInviteOnly;
	inviteOnly.value = x.isInviteOnly;
}

props.connection.on('changeReadyStates', onChangeReadyStates);
props.connection.on('joined', onJoined);
props.connection.on('left', onLeft);
props.connection.on('invited', onInvited);
props.connection.on('invitationCanceled', onInvitationCanceled);
props.connection.on('inviteOnlyChanged', onInviteOnlyChanged);

onUnmounted(() => {
	props.connection.off('changeReadyStates', onChangeReadyStates);
	props.connection.off('joined', onJoined);
	props.connection.off('left', onLeft);
	props.connection.off('invited', onInvited);
	props.connection.off('invitationCanceled', onInvitationCanceled);
	props.connection.off('inviteOnlyChanged', onInviteOnlyChanged);
});
</script>

<style lang="scss" module>
.seat {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 8px 0;
	border-top: solid 1px var(--MI_THEME-divider);

	&:first-child {
		border-top: none;
	}
}

.seatAvatar {
	width: 40px;
	height: 40px;
	flex-shrink: 0;
}

.seatName {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.seatBadge {
	flex-shrink: 0;
	width: 40px;
	padding: 4px 0;
	border-radius: 999px;
	font-size: 80%;
	font-weight: bold;
	text-align: center;
}

.seatCpu {
	background: var(--MI_THEME-accentedBg);
	color: var(--MI_THEME-accent);
}

.seatEmpty {
	opacity: 0.5;
}

.footer {
	-webkit-backdrop-filter: var(--blur, blur(15px));
	backdrop-filter: var(--blur, blur(15px));
	background: var(--acrylicBg);
	border-top: solid 0.5px var(--divider);
}
</style>
