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
// 式インデックスはエンティティメタデータで表現できないので、IDX_EMOJI_ROLE_IDSと同様にsynchronize: falseで宣言し
// 作成はハンドメイドmigration(1795021088953-AvatarDecorationHostRawUrlIndex.js)で行う。
// 対応する検索はAvatarDecorationService.remoteDecorationsFromApでmd5()を適用して行っている
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
