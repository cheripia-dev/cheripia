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
        // (host, md5(rawUrl))インデックスをUNIQUEにするための前準備として、既存の重複行を集約する。
        // UNIQUEインデックス自体の作成は次のmigration
        // (1795698643579-AvatarDecorationHostRawUrlUniqueIndexCreate.js)が行う。
        // 作成側はMISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLYでtransaction=falseになり得るため、
        // データ整理(this migration)とインデックス作成を同じトランザクションにまとめられない。
        // 一方、このmigrationと作成migrationの間に新しい重複行が増える窓があるため、
        // 作成migrationは自前で整理を再実行する(このmigrationの整理は冪等なので、
        // 作成側から同じ関数を呼び直しても安全)。
        //
        // リモート取り込み(AvatarDecorationService.createRemoteDecorationIfAbsent)は
        // ON CONFLICT DO NOTHING付きのINSERTで定義行を挿入するため、
        // 同一host・同一画像URLの並行アクター更新は定義行を単一の行に集約できる
        // (check-then-insertだと後発のSELECTが先発のコミット前に走るため重複行が作られる)。
        //
        // 複数の行を持つすべての(host, md5(rawUrl))グループでid最小の行を保持し、
        // 重複行を指すuser.avatarDecorationsのエントリを保持行のidへ書き換え、重複行を削除する。
        // hostとrawUrlが双方NOT NULLの行だけをグループ化する。
        // user.avatarDecorationsはjsonb配列のときだけ展開し、重複参照でない要素(オブジェクトでない要素含む)
        // は元の順序のまま保持する。
        //
        // SET LOCAL statement_timeout = 0: 以降のuserテーブルスキャンは、大規模インスタンスでは
        // アプリケーションのDataSourceやdb.extraが設定するstatement_timeoutを超える可能性がある。
        // migrationsTransactionModeが'all'(既定)の場合は1回の実行の全migrationが単一トランザクションを
        // 共有するため、SET LOCALの効果が後続のmigrationへ波及する。'each'
        // (MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY=1)の場合と、作成migrationから明示トランザクション
        // 経由で呼び出される場合はこのトランザクションだけに影響する
        await queryRunner.query(`SET LOCAL statement_timeout = 0`);

        await this.deduplicateByHostAndRawUrl(queryRunner);
    }

    /**
     * @param {QueryRunner} queryRunner
     */
    async down(queryRunner) {
        // 削除した重複行と書き換えたuser.avatarDecorationsは、各ユーザーがどの行を参照していたかを
        // 特定できないため復元できない。このmigrationが対象とするのはデータ整理だけで、
        // 元データ(重複行とその参照)は意図的に破棄する。down()でスキーマを巻き戻す処理は無い
        // (インデックスの削除は作成migrationのdown()が担う)
    }

    /**
     * (host, md5(rawUrl))の重複行をid最小の行へ集約する。
     * このmigrationのup()と、インデックス作成migration
     * (1795698643579-AvatarDecorationHostRawUrlUniqueIndexCreate.js)の両方から呼ぶ。
     * 呼び出し側はトランザクション内で実行すること
     * (SET LOCAL statement_timeoutとCREATE TEMP TABLE ... ON COMMIT DROPがトランザクションを要する)。
     * @param {QueryRunner} queryRunner
     */
    async deduplicateByHostAndRawUrl(queryRunner) {
        // 重複ペア(重複行id -> 保持行id)を一度だけ構築する
        // (削除と書き換えの間に他のINSERTが入ると集約対象がずれるため)。
        // window関数ならテーブルを1回スキャンしながら(host, md5(rawUrl))ごとの最小idを求められる。
        // 以前のGROUP BY + 自己結合は行数とほぼ同数のグループを実体化する必要があり、
        // 1000万行では3〜4倍遅かった。
        // ON COMMIT DROPでトランザクションのコミット時に消える
        await queryRunner.query(`
            CREATE TEMP TABLE "tmp_avatar_decoration_dupe_pairs" ON COMMIT DROP AS
            SELECT "id" AS "dupe_id", "keep_id"
            FROM (
                SELECT "id",
                    first_value("id") OVER (PARTITION BY "host", md5("rawUrl") ORDER BY "id") AS "keep_id"
                FROM "avatar_decoration"
                WHERE "host" IS NOT NULL AND "rawUrl" IS NOT NULL
            ) "d"
            WHERE "id" <> "keep_id"
        `);

        // CREATE TEMP TABLE ... ASを実行すると、一時テーブルに統計情報が保持されない(reltuples = -1)。
        // この状態でUPDATEが計画されると、プランナはuser行ごとに一時テーブルを再スキャンする
        // ネストループを選択することがあり、100万ユーザー規模のテーブルが実質的にハング状態になる。
        // ANALYZEは処理負荷が低く、プランナに実際の行数を提供する
        await queryRunner.query(`ANALYZE "tmp_avatar_decoration_dupe_pairs"`);

        // 重複が無い場合は、userテーブルの全スキャンとDELETEを省略する
        const [{ exists }] = await queryRunner.query(`SELECT EXISTS (SELECT 1 FROM "tmp_avatar_decoration_dupe_pairs") AS "exists"`);
        if (!exists) {
            return;
        }

        // jsonb_setはobject要素にのみ適用する。jsonbスカラー要素(文字列等)が混ざっていても書き換えが失敗しない。
        // LATERAL式内のCASEが既に非配列値を空配列へ変換するため、
        // jsonb_typeof(...) = 'array'のフィルタは不要。そのフィルタはプランナに実際のカーディナリティを
        // 隠蔽し(デフォルトの選択率0.5%)、不適切なネストループプランを誘発する
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
                GROUP BY "src"."id"
            ) "sub"
            WHERE "u"."id" = "sub"."user_id"
                AND "sub"."new_value" IS DISTINCT FROM "u"."avatarDecorations"
        `);

        await queryRunner.query(`
            DELETE FROM "avatar_decoration"
            WHERE "id" IN (SELECT "dupe_id" FROM "tmp_avatar_decoration_dupe_pairs")
        `);
    }
}
