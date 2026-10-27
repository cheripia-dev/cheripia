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
        await queryRunner.query(`ALTER TABLE "user_profile" ADD "includeChannelPostsInTimeline" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`COMMENT ON COLUMN "user_profile"."includeChannelPostsInTimeline" IS 'Whether to include channel posts of followed users in the home timeline.'`);
    }

    /**
     * @param {QueryRunner} queryRunner
     */
    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN "includeChannelPostsInTimeline"`);
    }
}
