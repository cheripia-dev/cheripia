/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class IncludeChannelPostsInTimeline1793067389581 {
    name = 'IncludeChannelPostsInTimeline1793067389581';

    /**
     * @param {QueryRunner} queryRunner
     */
    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "user" ADD "includeChannelPostsInTimeline" boolean NOT NULL DEFAULT false`);
    }

    /**
     * @param {QueryRunner} queryRunner
     */
    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "includeChannelPostsInTimeline"`);
    }
}
