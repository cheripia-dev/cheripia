/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Index, Column, ManyToOne, JoinColumn } from 'typeorm';
import { id } from './util/id.js';

@Entity('avatar_decoration')
// APub受信(remoteDecorationsFromAp)の重複排除が(host, rawUrl)で毎回検索するため順次スキャンを避けるインデックスを付ける。
// rawUrlは長さ無制限のtextで、(host, rawUrl)のままではbtreeのインデックス行サイズ上限(約2704バイト)を超える行が
// CREATE INDEX / INSERT の失敗要因になるため、ハッシュ式インデックス(host, md5(rawUrl))にする。
// インデックスはUNIQUEで、取り込みはON CONFLICT DO NOTHINGで挿入(createRemoteDecorationIfAbsent)するため、
// 同一hostの複数ユーザーが同じ画像URLを同時に取り込んでも定義行は1行に収束する
// (check-then-insertだと後発のSELECTが先発のコミット前に走るため重複行が作られる)。
// hostがNULL(ローカル行)またはrawUrlがNULL(旧API方式(remoteUserUpdate)行)の行は、UNIQUEインデックスで
// NULL同士が非一致になるため制約の対象外。
// 式インデックスはエンティティメタデータで表現できないので、IDX_EMOJI_ROLE_IDSと同様にsynchronize: falseで宣言し
// 作成はハンドメイドmigrationで行う(1795147371786-AvatarDecorationHostRawUrlUniqueIndex.jsで
// 既存重複行を整理し、1795698643579-AvatarDecorationHostRawUrlUniqueIndexCreate.jsで
// UNIQUEインデックスを作る。MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY対応のため整理と作成は別migration)。
// 対応する検索はAvatarDecorationService.findRemoteDecorationByRawUrlでmd5()を適用して行っている
@Index('IDX_avatar_decoration_host_raw_url_md5', { synchronize: false })
export class MiAvatarDecoration {
	@PrimaryColumn(id())
	public id: string;

	@Column('timestamp with time zone', {
		nullable: true,
	})
	public updatedAt: Date | null;

	@Column('varchar', {
		length: 1024,
	})
	public url: string;

	@Column('varchar', {
		length: 256,
	})
	public name: string;

	@Column('varchar', {
		length: 2048,
	})
	public description: string;

	// TODO: 定期ジョブで存在しなくなったロールIDを除去するようにする
	@Column('varchar', {
		array: true, length: 128, default: '{}',
	})
	public roleIdsThatCanBeUsedThisDecoration: string[];

	@Column('varchar', {
		length: 128, nullable: true,
	})
	public category: string | null;

	@Column('varchar', {
		length: 32, nullable: true,
	})
	public remoteId: string | null;

	@Column('varchar', {
		length: 128, nullable: true,
	})
	public host: string | null;

	@Column('text', {
		nullable: true,
	})
	public rawUrl: string | null;
}
