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
        // rawUrlは長さ無制限のtextなので生の列にはbtreeインデックスを張れない(インデックス行サイズ上限 約2704バイト)。
        // 固定長(32文字)のmd5()へハッシュした複合式インデックスにする。
        // md5()はPostgreSQL coreのimmutable関数なのでpgcryptoのCREATE EXTENSIONは不要。
        // 一致検索(md5(rawUrl)=md5(引数))にのみ使われる。エンティティ側はsynchronize: falseで宣言(models/AvatarDecoration.ts)
        await queryRunner.query(`CREATE INDEX "IDX_avatar_decoration_host_raw_url_md5" ON "avatar_decoration" ("host", md5("rawUrl"))`);
    }

    /**
     * @param {QueryRunner} queryRunner
     */
    async down(queryRunner) {
        await queryRunner.query(`DROP INDEX "IDX_avatar_decoration_host_raw_url_md5"`);
    }
}
