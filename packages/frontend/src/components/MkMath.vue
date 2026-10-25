<!--
SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- eslint-disable-next-line vue/no-v-html -->
<span v-if="!displayMode" v-html="html"></span>
<!-- eslint-disable-next-line vue/no-v-html -->
<div v-else v-html="html"></div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import temml from 'temml/dist/temml.mjs';

const props = withDefaults(defineProps<{
	formula: string;
	displayMode?: boolean;
}>(), {
	displayMode: false,
});

const html = computed(() => temml.renderToString(props.formula, { displayMode: props.displayMode }));
</script>
