/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Redis from 'ioredis';
import { loadConfig } from '../built/config.js';

const removedAchievements = ['setNameToYojo', 'ohayoujo1', 'ohayoujo7', 'ohayoujo30', 'ohayoujo365'];

export class RemoveAchievements1792851267884 {
    name = 'RemoveAchievements1792851267884';

    async up(queryRunner) {
        const users = await queryRunner.query(`
            WITH updated AS (
                UPDATE "user_profile" AS profile
                SET "achievements" = COALESCE((
                    SELECT jsonb_agg(achievement ORDER BY position)
                    FROM jsonb_array_elements(profile."achievements") WITH ORDINALITY AS entries(achievement, position)
                    WHERE achievement->>'name' IS NULL OR NOT (achievement->>'name' = ANY($1::text[]))
                ), '[]'::jsonb)
                WHERE EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(profile."achievements") AS achievement
                    WHERE achievement->>'name' = ANY($1::text[])
                )
                RETURNING "userId"
            )
            SELECT "userId" FROM updated
        `, [removedAchievements]);

        if (users.length === 0) return;

        // Notifications live in Redis, not PostgreSQL. Remove the corresponding
        // notifications before their locale entries disappear from the client.
        const redis = new Redis({ ...loadConfig().redis, lazyConnect: true, maxRetriesPerRequest: 1 });
        try {
            await redis.connect();
            for (const { userId } of users) {
                const key = `notificationTimeline:${userId}`;
                const notifications = await redis.xrange(key, '-', '+');
                const ids = notifications.filter(([, fields]) => {
                    const notification = JSON.parse(fields[fields.indexOf('data') + 1]);
                    return notification.type === 'achievementEarned' && removedAchievements.includes(notification.achievement);
                }).map(([id]) => id);
                if (ids.length > 0) await redis.xdel(key, ...ids);
            }
        } finally {
            redis.disconnect();
        }
    }

    async down() {
        throw new Error('Removed achievement history and notifications cannot be restored. Restore a backup to roll back this migration.');
    }
}
