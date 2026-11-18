/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class AvatarDecorationHostRawUrlIndex1795021088953 {
    name = 'AvatarDecorationHostRawUrlIndex1795021088953';

    /**
     * @param {QueryRunner} queryRunner
     */
    async up(queryRunner) {
        await queryRunner.query(`CREATE INDEX "IDX_b6f4724b23f6ca1f77b29724cd" ON "avatar_decoration" ("host", "rawUrl")`);
    }

    /**
     * @param {QueryRunner} queryRunner
     */
    async down(queryRunner) {
        await queryRunner.query(`DROP INDEX "IDX_b6f4724b23f6ca1f77b29724cd"`);
    }
}
