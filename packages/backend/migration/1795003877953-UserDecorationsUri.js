/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class UserDecorationsUri1795003877953 {
    name = 'UserDecorationsUri1795003877953';

    /**
     * @param {QueryRunner} queryRunner
     */
    async up(queryRunner) {
        await queryRunner.query('ALTER TABLE "user" ADD "decorationsUri" character varying(512)');
    }

    /**
     * @param {QueryRunner} queryRunner
     */
    async down(queryRunner) {
        await queryRunner.query('ALTER TABLE "user" DROP COLUMN "decorationsUri"');
    }
};
