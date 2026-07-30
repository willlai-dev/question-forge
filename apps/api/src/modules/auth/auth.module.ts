import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfService } from './csrf.service';
import { CsrfGuard, JwtAuthGuard } from './guards';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * 認證模組。
 *
 * JwtModule 不在此設定 secret：secret 由 TokenService 在簽章／驗證時
 * 從已驗證的 Env 明確帶入，避免密鑰散落在模組設定中。
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, CsrfService, JwtAuthGuard, CsrfGuard],
  exports: [AuthService, TokenService, CsrfService, JwtAuthGuard, CsrfGuard],
})
export class AuthModule {}
