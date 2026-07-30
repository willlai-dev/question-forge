import { Algorithm, hash, verify } from '@node-rs/argon2';
import { Injectable } from '@nestjs/common';

/**
 * 密碼雜湊。
 *
 * 使用 argon2id，參數採 OWASP 建議值（memoryCost 19 MiB、timeCost 2、parallelism 1）。
 * 選用 @node-rs/argon2 而非 argon2 套件：前者提供預編譯二進位，
 * 在 Windows 上不需要安裝 C++ build toolchain。
 */
@Injectable()
export class PasswordService {
  private readonly options = {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  };

  hash(plainPassword: string): Promise<string> {
    return hash(plainPassword, this.options);
  }

  async verify(passwordHash: string, plainPassword: string): Promise<boolean> {
    try {
      return await verify(passwordHash, plainPassword);
    } catch {
      // 雜湊格式損毀時視為驗證失敗，而不是拋出 500 洩漏內部狀態。
      return false;
    }
  }
}
