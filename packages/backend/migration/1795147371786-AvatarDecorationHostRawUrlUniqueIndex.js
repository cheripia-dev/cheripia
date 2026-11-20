/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class AvatarDecorationHostRawUrlUniqueIndex1795147371786 {
    name = 'AvatarDecorationHostRawUrlUniqueIndex1795147371786';

    /**
     * @param {QueryRunner} queryRunner
     */
    async up(queryRunner) {
        // (host, md5(rawUrl))インデックスをUNIQUEにする。
        // リモート取り込み(AvatarDecorationService.createRemoteDecorationIfAbsent)は
        // ON CONFLICT DO NOTHING付きのINSERTで定義行を挿入するため、
        // 同一host・同一画像URLの並行アクター更新は定義行を単一の行に集約できる
        // (check-then-insertだと後発のSELECTが先発のコミット前に走るため重複行が作られる)。
        //
        // UNIQUE化の前に既存の重複行を集約する。複数の行を持つすべての(host, md5(rawUrl))グループで
        // id最小の行を保持し、重複行を指すuser.avatarDecorationsのエントリを保持行のidへ書き換え、
        // 重複行を削除する。hostとrawUrlが双方NOT NULLの行だけをグループ化する。
        // user.avatarDecorationsはjsonb配列のときだけ展開し、重複参照でない要素(オブジェクトでない要素含む)
        // は元の順序のまま保持する。
        //
        // SET LOCAL statement_timeout = 0: 以降のuserテーブルスキャンは、大規模インスタンスでは
        // アプリケーションのDataSourceが設定する10秒のstatement_timeoutを超える可能性がある。
        // マイグレーションはトランザクション内で走るため、SET LOCALはこのマイグレーションにだけ影響する
        await queryRunner.query(`SET LOCAL statement_timeout = 0`);

        // 重複ペア(重複行id -> 保持行id)は一度だけ実体化し、書き換えと削除で同じマッピングを使う
        // (削除と書き換えの間に他のINSERTが入ると集約対象がずれるため)。
        // ON COMMIT DROPでマイグレーションのコミット時に消える
        await queryRunner.query(`
            CREATE TEMP TABLE "tmp_avatar_decoration_dupe_pairs" ON COMMIT DROP AS
            SELECT "d"."id" AS "dupe_id", "g"."keep_id"
            FROM "avatar_decoration" "d"
            JOIN (
                SELECT "host", md5("rawUrl") AS "raw_url_md5", min("id") AS "keep_id"
                FROM "avatar_decoration"
                WHERE "host" IS NOT NULL AND "rawUrl" IS NOT NULL
                GROUP BY "host", md5("rawUrl")
                HAVING count(*) > 1
            ) "g" ON "g"."host" = "d"."host" AND md5("d"."rawUrl") = "g"."raw_url_md5"
            WHERE "d"."id" <> "g"."keep_id"
        `);

        // jsonb_setはobject要素にのみ適用する。jsonbスカラー要素(文字列等)が混ざっていても書き換えが失敗しない
        await queryRunner.query(`
            UPDATE "user" "u"
            SET "avatarDecorations" = "sub"."new_value"
            FROM (
                SELECT "src"."id" AS "user_id",
                    jsonb_agg(
                        CASE
                            WHEN p."keep_id" IS NOT NULL AND jsonb_typeof(e."elem") = 'object'
                                THEN jsonb_set(e."elem", '{id}', to_jsonb(p."keep_id"))
                            ELSE e."elem"
                        END
                        ORDER BY e."ord"
                    ) AS "new_value"
                FROM "user" "src"
                CROSS JOIN LATERAL jsonb_array_elements(
                    CASE
                        WHEN jsonb_typeof("src"."avatarDecorations") = 'array' THEN "src"."avatarDecorations"
                        ELSE '[]'::jsonb
                    END
                ) WITH ORDINALITY AS e("elem", "ord")
                LEFT JOIN "tmp_avatar_decoration_dupe_pairs" p ON p."dupe_id" = e."elem" ->> 'id'
                WHERE jsonb_typeof("src"."avatarDecorations") = 'array'
                GROUP BY "src"."id"
            ) "sub"
            WHERE "u"."id" = "sub"."user_id"
                AND "sub"."new_value" IS DISTINCT FROM "u"."avatarDecorations"
        `);

        await queryRunner.query(`
            DELETE FROM "avatar_decoration"
            WHERE "id" IN (SELECT "dupe_id" FROM "tmp_avatar_decoration_dupe_pairs")
        `);

        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_avatar_decoration_host_raw_url_md5"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_avatar_decoration_host_raw_url_md5" ON "avatar_decoration" ("host", md5("rawUrl"))`);
    }

    /**
     * @param {QueryRunner} queryRunner
     */
    async down(queryRunner) {
        // 削除した重複行と書き換えたuser.avatarDecorationsは、各ユーザーがどの行を参照していたかを
        // 特定できないため復元できない。巻き戻せるのはインデックスの制約だけで、非UNIQUEに戻す
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_avatar_decoration_host_raw_url_md5"`);
        await queryRunner.query(`CREATE INDEX "IDX_avatar_decoration_host_raw_url_md5" ON "avatar_decoration" ("host", md5("rawUrl"))`);
    }
}
