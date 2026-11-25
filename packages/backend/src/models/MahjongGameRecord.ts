/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';

/**
 * 終局した麻雀対局の結果。ルームは Redis にのみ保存され TTL で失効するため、
 * 対局履歴一覧はこのテーブルを参照する。
 */
@Entity('mahjong_game_record')
@Index(['participantIds'], { type: 'gin' })
export class MiMahjongGameRecord {
	@PrimaryColumn(id())
	public id: string;

	@Column('timestamp with time zone', {
		comment: 'The started date of the MahjongGameRecord.',
	})
	public startedAt: Date;

	@Column('timestamp with time zone', {
		comment: 'The ended date of the MahjongGameRecord.',
	})
	public endedAt: Date;

	@Column('varchar', {
		length: 32,
	})
	public matchLength: string;

	/**
	 * 終局理由。'tobi' はいずれかの持ち点が0以下になったことによる終了、
	 * 'normal' は規定局数の消化による終了。
	 */
	@Column('varchar', {
		length: 32,
	})
	public endReason: string;

	// in sec
	@Column('smallint', {
		default: 30,
	})
	public timeLimitForEachTurn: number;

	/** 人間参加者のユーザーID。CPU席は含まない。my 絞り込みの検索用。 */
	@Column('varchar', {
		array: true,
		default: () => "'{}'",
	})
	public participantIds: string[];

	/**
	 * 1番席のユーザー。CPU席または退会済みユーザーなら null。
	 */
	@Column({
		...id(),
		nullable: true,
	})
	public user1Id: MiUser['id'] | null;

	@ManyToOne(() => MiUser, {
		onDelete: 'SET NULL',
	})
	@JoinColumn()
	public user1: MiUser | null;

	@Column('boolean', {
		default: false,
	})
	public user1Ai: boolean;

	@Column('integer', {
		default: 0,
	})
	public user1Points: number;

	@Column('smallint', {
		default: 0,
	})
	public user1Rank: number;

	/**
	 * 2番席のユーザー。CPU席または退会済みユーザーなら null。
	 */
	@Column({
		...id(),
		nullable: true,
	})
	public user2Id: MiUser['id'] | null;

	@ManyToOne(() => MiUser, {
		onDelete: 'SET NULL',
	})
	@JoinColumn()
	public user2: MiUser | null;

	@Column('boolean', {
		default: false,
	})
	public user2Ai: boolean;

	@Column('integer', {
		default: 0,
	})
	public user2Points: number;

	@Column('smallint', {
		default: 0,
	})
	public user2Rank: number;

	/**
	 * 3番席のユーザー。CPU席または退会済みユーザーなら null。
	 */
	@Column({
		...id(),
		nullable: true,
	})
	public user3Id: MiUser['id'] | null;

	@ManyToOne(() => MiUser, {
		onDelete: 'SET NULL',
	})
	@JoinColumn()
	public user3: MiUser | null;

	@Column('boolean', {
		default: false,
	})
	public user3Ai: boolean;

	@Column('integer', {
		default: 0,
	})
	public user3Points: number;

	@Column('smallint', {
		default: 0,
	})
	public user3Rank: number;

	/**
	 * 4番席のユーザー。CPU席または退会済みユーザーなら null。
	 */
	@Column({
		...id(),
		nullable: true,
	})
	public user4Id: MiUser['id'] | null;

	@ManyToOne(() => MiUser, {
		onDelete: 'SET NULL',
	})
	@JoinColumn()
	public user4: MiUser | null;

	@Column('boolean', {
		default: false,
	})
	public user4Ai: boolean;

	@Column('integer', {
		default: 0,
	})
	public user4Points: number;

	@Column('smallint', {
		default: 0,
	})
	public user4Rank: number;
}
