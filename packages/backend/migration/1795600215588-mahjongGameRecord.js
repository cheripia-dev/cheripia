/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class MahjongGameRecord1795600215588 {
    name = 'MahjongGameRecord1795600215588'

    /**
     * @param {QueryRunner} queryRunner
     */
    async up(queryRunner) {
        await queryRunner.query(`CREATE TABLE "mahjong_game_record" ("id" character varying(32) NOT NULL, "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "endedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "matchLength" character varying(32) NOT NULL, "endReason" character varying(32) NOT NULL, "timeLimitForEachTurn" smallint NOT NULL DEFAULT '30', "participantIds" character varying array NOT NULL DEFAULT '{}'::character varying[], "user1Id" character varying(32), "user1Ai" boolean NOT NULL DEFAULT false, "user1Points" integer NOT NULL DEFAULT '0', "user1Rank" smallint NOT NULL DEFAULT '0', "user2Id" character varying(32), "user2Ai" boolean NOT NULL DEFAULT false, "user2Points" integer NOT NULL DEFAULT '0', "user2Rank" smallint NOT NULL DEFAULT '0', "user3Id" character varying(32), "user3Ai" boolean NOT NULL DEFAULT false, "user3Points" integer NOT NULL DEFAULT '0', "user3Rank" smallint NOT NULL DEFAULT '0', "user4Id" character varying(32), "user4Ai" boolean NOT NULL DEFAULT false, "user4Points" integer NOT NULL DEFAULT '0', "user4Rank" smallint NOT NULL DEFAULT '0', CONSTRAINT "PK_197992b09b2e49806087757706e" PRIMARY KEY ("id")); COMMENT ON COLUMN "mahjong_game_record"."startedAt" IS 'The started date of the MahjongGameRecord.'; COMMENT ON COLUMN "mahjong_game_record"."endedAt" IS 'The ended date of the MahjongGameRecord.'`);
        await queryRunner.query(`CREATE INDEX "IDX_c497b6618bfff65559c59dbc62" ON "mahjong_game_record" USING gin ("participantIds")`);
        await queryRunner.query(`ALTER TABLE "mahjong_game_record" ADD CONSTRAINT "FK_754ec2df6edca960ce6a70a8746" FOREIGN KEY ("user1Id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "mahjong_game_record" ADD CONSTRAINT "FK_2ef421331035f645cab34b5ffd0" FOREIGN KEY ("user2Id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "mahjong_game_record" ADD CONSTRAINT "FK_a160a333cf2272a44b088ef5b52" FOREIGN KEY ("user3Id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "mahjong_game_record" ADD CONSTRAINT "FK_330288ee8074f801b2947e77f1d" FOREIGN KEY ("user4Id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    /**
     * @param {QueryRunner} queryRunner
     */
    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "mahjong_game_record" DROP CONSTRAINT "FK_330288ee8074f801b2947e77f1d"`);
        await queryRunner.query(`ALTER TABLE "mahjong_game_record" DROP CONSTRAINT "FK_a160a333cf2272a44b088ef5b52"`);
        await queryRunner.query(`ALTER TABLE "mahjong_game_record" DROP CONSTRAINT "FK_2ef421331035f645cab34b5ffd0"`);
        await queryRunner.query(`ALTER TABLE "mahjong_game_record" DROP CONSTRAINT "FK_754ec2df6edca960ce6a70a8746"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c497b6618bfff65559c59dbc62"`);
        await queryRunner.query(`DROP TABLE "mahjong_game_record"`);
    }
}
