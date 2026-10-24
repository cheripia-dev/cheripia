/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable import/no-default-export */
import type { StoryObj } from '@storybook/vue3';
import MkMath from './MkMath.vue';

export const Default = {
	render(args) {
		return {
			components: {
				MkMath,
			},
			setup() {
				return {
					args,
				};
			},
			computed: {
				props() {
					return {
						...this.args,
					};
				},
			},
			template: '<MkMath v-bind="props"/>',
		};
	},
	args: {
		formula: 'E = mc^2',
	},
	parameters: {
		layout: 'centered',
	},
} satisfies StoryObj<typeof MkMath>;
export const Display = {
	...Default,
	args: {
		...Default.args,
		displayMode: true,
		formula: '\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}',
	},
} satisfies StoryObj<typeof MkMath>;
