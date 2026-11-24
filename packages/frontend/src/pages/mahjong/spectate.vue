<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- 観戦は通常の対局画面をそのまま使い、画面内で視点プレイヤーを選ぶ -->
<Room :roomId="roomId" :spectate="true" :spectateUser="spectateUser"/>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import Room from './room.vue';
import { definePage } from '@/page.js';
import { i18n } from '@/i18n.js';

defineProps<{
	roomId: string;
	spectateUser?: string;
}>();

definePage(computed(() => ({
	title: i18n.ts._mahjong.spectating,
	icon: 'ti ti-eye',
})));
</script>
