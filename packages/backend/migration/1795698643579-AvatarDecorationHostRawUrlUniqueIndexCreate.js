/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { isConcurrentIndexMigrationEnabled } from './js/migration-config.js';

const INDEX_NAME = 'IDX_avatar_decoration_host_raw_url_md5';
const TABLE_NAME = 'avatar_decoration';

// src/misc/is-duplicate-key-value-error.tsと同じ判定。migrationは自己完結が既定で、
// built/のバンドル出力(layoutがビルドごとに変わる)をimportするのは不安定なのでここで定義する
function isDuplicateKeyValueError(e) {
    return typeof e?.code === 'string' ? e.code === '23505' : e?.driverError?.code === '23505';
}

// 整理済み集合へのINSERTはUNIQUE制約で止まるため、CONCURRENTLY作成のunique_violationは
// 「整理の完了後に増えた重複」が原因で、整理の再実行で解消できる。
// 再実行(userテーブルの全スキャンを伴う)のコストがあるため上限を設ける
const MAX_CREATE_ATTEMPTS = 3;

export class AvatarDecorationHostRawUrlUniqueIndexCreate1795698643579 {
    name = 'AvatarDecorationHostRawUrlUniqueIndexCreate1795698643579';

    // CREATE UNIQUE INDEX CONCURRENTLYはトランザクション内で実行できないため、
    // フラグ有効時はこのmigrationにtransactionを張らない。
    // フラグ無効時は(migrationsTransactionMode='all'の既定)前のmigration
    // (1795147371786-AvatarDecorationHostRawUrlUniqueIndex.js)と単一トランザクションを共有し、
    // 整理とインデックス作成の間に書き込みが入らない
    transaction = isConcurrentIndexMigrationEnabled() ? false : undefined;

    /**
     * @param {QueryRunner} queryRunner
     */
    async up(queryRunner) {
        if (isConcurrentIndexMigrationEnabled()) {
            await this.upConcurrently(queryRunner);
        } else {
            // 前のmigrationで重複が整理済みで、同じトランザクションのためこの時点で重複は存在しない。
            // 旧形式のインデックス(host, rawUrl)が残っている環境があれば置き換える
            await queryRunner.query(`DROP INDEX IF EXISTS "${INDEX_NAME}"`);
            await queryRunner.query(`CREATE UNIQUE INDEX "${INDEX_NAME}" ON "${TABLE_NAME}" ("host", md5("rawUrl"))`);
        }
    }

    /**
     * @param {QueryRunner} queryRunner
     */
    async down(queryRunner) {
        // 削除した重複行と書き換えたuser.avatarDecorationsは各ユーザーがどの行を参照していたかを
        // 特定できないため復元できない。巻き戻せるのはインデックスだけで、
        // このブランチより前のスキーマにはインデックスが無かったため、down()は単に削除する
        if (isConcurrentIndexMigrationEnabled()) {
            // 無効インデックス(失敗したCONCURRENTLY作成の残骸)もDROPできる
            await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX_NAME}"`);
        } else {
            await queryRunner.query(`DROP INDEX IF EXISTS "${INDEX_NAME}"`);
        }
    }

    /**
     * CONCURRENTLY経路。CREATE INDEX CONCURRENTLYは他の書き込みを止められないため、
     * 整理からインデックス作成完了までの間に古いプロセスが重複行を挿入する窓がある。
     * 作成がunique_violationで失敗したら(CONCURRENTLY作成は失敗時点で一意性を強制し始めるので、
     * その後の挿入は重複を作らない)、整理を再実行して作り直せば収束する。
     * @param {QueryRunner} queryRunner
     */
    async upConcurrently(queryRunner) {
        // 既に「有効かつUNIQUE」なインデックスが在る(前回の完走)なら何もしない。
        // 開発ブランチの旧版migrationが作った非UNIQUEの同名インデックスはindisvalid=trueなので、
        // indisuniqueも確認しないと置き換え対象を見逃す(失敗したCONCURRENTLY作成の残骸は
        // indisvalid=falseなので条件を通過し、ループ先頭のDROPで消える)
        const valid = await queryRunner.query(`
            SELECT "indisvalid", "indisunique" FROM "pg_index"
            INNER JOIN "pg_class" ON "pg_index"."indexrelid" = "pg_class"."oid"
            WHERE "pg_class"."relname" = '${INDEX_NAME}'
        `);
        if (valid.length > 0 && valid[0].indisvalid === true && valid[0].indisunique === true) {
            return;
        }

        for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt++) {
            // 前の試行が残した無効インデックスの残骸を消す(transaction=falseなのでautocommitで DROPできる)
            await queryRunner.query(`DROP INDEX IF EXISTS "${INDEX_NAME}"`);

            // 整理を自前の短いトランザクションで実行する。
            // migrationsTransactionMode='each'でもtransaction=falseのmigrationにはトランザクションが
            // 張られないので、SET LOCAL statement_timeoutとCREATE TEMP TABLE ... ON COMMIT DROPが
            // 働くようにここでのみトランザクションを明示する
            await queryRunner.startTransaction();
            try {
                await this.deduplicateByHostAndRawUrl(queryRunner);
                await queryRunner.commitTransaction();
            } catch (e) {
                await queryRunner.rollbackTransaction().catch(() => {});
                throw e;
            }

            try {
                await queryRunner.query(`CREATE UNIQUE INDEX CONCURRENTLY "${INDEX_NAME}" ON "${TABLE_NAME}" ("host", md5("rawUrl"))`);
                // CONCURRENTLY作成は統計を收集しないため、インデックスを有効にするANALYZEで補う
                await queryRunner.query(`ANALYZE "${TABLE_NAME}"`);
                return;
            } catch (e) {
                if (!isDuplicateKeyValueError(e)) throw e;
                // 残骸の無効インデックスはループ先頭でDROPする
            }
        }

        throw new Error(
            `CREATE UNIQUE INDEX CONCURRENTLY "${INDEX_NAME}" failed after ${MAX_CREATE_ATTEMPTS} attempts: ` +
            `duplicate (host, rawUrl) rows keep appearing while building the index. ` +
            `Stop the old Misskey processes (rolling deploy in progress) so that the pre-index ` +
            `code paths cannot insert new duplicates, then run the migration again.`,
        );
    }

    /**
     * 前のmigration (1795147371786-AvatarDecorationHostRawUrlUniqueIndex.js)の整理処理と同じ。
     * migrationは自己完結が既定(他ファイルからのimportは無い)なので、SQLをこちらにも置く。
     * 呼び出し側はトランザクション内で実行すること
     * (SET LOCAL statement_timeoutとCREATE TEMP TABLE ... ON COMMIT DROPがトランザクションを要する)。
     * @param {QueryRunner} queryRunner
     */
    async deduplicateByHostAndRawUrl(queryRunner) {
        // 重複ペア(重複行id -> 保持行id)を一度だけ構築する
        // (削除と書き換えの間に他のINSERTが入ると集約対象がずれるため)。
        // window関数ならテーブルを1回スキャンしながら(host, md5(rawUrl))ごとの最小idを求められる。
        // ON COMMIT DROPでトランザクションのコミット時に消える
        await queryRunner.query(`SET LOCAL statement_timeout = 0`);
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
