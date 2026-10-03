/**
 * Создаёт (или сбрасывает пароль) тестовому аккаунту для автотеста браузерного клиента.
 * Нужен, чтобы e2e-скрипт логинился сам, не дёргая живого игрока и не трогая его учётку.
 *
 *   ts-node -r tsconfig-paths/register scripts/e2e-account.ts [ник] [пароль]
 *
 * По умолчанию: e2e / e2e12345
 */
import "dotenv/config";
import { connectToDatabase, disconnectFromDatabase } from "@/database";
import { UserService } from "@/shared/services/user.service";
import { RankService } from "@/shared/services/rank.service";
import User from "@/shared/models/user.model";

async function main(): Promise<void> {
    const username = process.argv[2] || "e2e";
    const password = process.argv[3] || "e2e12345";

    await connectToDatabase();

    const existing = await User.findOneBy({ login: username.toLowerCase() });
    if (existing) {
        existing.password = password; // pre-save хук модели хеширует
        await existing.save();
        console.log(`пароль обновлён: ${username} / ${password}`);
    } else {
        const userService = new UserService(new RankService());
        await userService.createUser({ username, password, email: null, crystals: 1000000 });
        console.log(`аккаунт создан: ${username} / ${password}`);
    }

    await disconnectFromDatabase();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
