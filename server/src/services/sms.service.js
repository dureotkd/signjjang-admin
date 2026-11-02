const { SolapiMessageService } = require('solapi');
const { AppError } = require('../errors');

class SmsService {
  constructor(config) {
    this.config = config;
    this.isConfigured = Boolean(
      config.solapiApiKey && config.solapiApiSecret && config.solapiSender,
    );
    this.client = this.isConfigured
      ? new SolapiMessageService(config.solapiApiKey, config.solapiApiSecret)
      : null;
    this.isAligoConfigured = Boolean(
      config.aligoApiKey && config.aligoUserId && config.aligoSender,
    );
  }

  async sendVerificationCode(phone, code) {
    if (this.config.devMode) {
      return { devCode: code, providerMessageId: null };
    }

    const configuredTtl = Number(this.config.codeTtlSeconds);
    const ttlSeconds = Number.isInteger(configuredTtl) && configuredTtl > 0 ? configuredTtl : 180;
    const ttlLabel = ttlSeconds % 60 === 0 ? `${ttlSeconds / 60}분` : `${ttlSeconds}초`;
    const message = `[싸인짱] 인증번호 ${code} (${ttlLabel} 이내 입력)`;

    if (this.isAligoConfigured) {
      const form = new URLSearchParams({
        key: this.config.aligoApiKey,
        user_id: this.config.aligoUserId,
        sender: this.config.aligoSender,
        receiver: phone,
        msg: message,
        msg_type: 'SMS',
      });
      try {
        const response = await fetch('https://apis.aligo.in/send/', {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw new AppError(502, 'SMS_SEND_FAILED', '인증번호 문자 발송에 실패했습니다. 잠시 후 다시 시도해주세요.');
        }
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new AppError(502, 'SMS_SEND_FAILED', '인증번호 문자 발송 결과를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.');
        }
        const providerMessageId = typeof payload?.msg_id === 'string'
          ? payload.msg_id.trim()
          : typeof payload?.msg_id === 'number' && Number.isFinite(payload.msg_id) && payload.msg_id > 0
            ? String(payload.msg_id)
            : '';
        if (
          ![1, '1'].includes(payload?.result_code)
          || ![1, '1'].includes(payload?.success_cnt)
          || ![0, '0'].includes(payload?.error_cnt)
          || !providerMessageId
        ) {
          throw new AppError(502, 'SMS_SEND_FAILED', '인증번호 문자 발송에 실패했습니다. 잠시 후 다시 시도해주세요.');
        }
        return { providerMessageId };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(502, 'SMS_UNAVAILABLE', '문자 발송 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.');
      }
    }

    if (!this.client) {
      throw new AppError(503, 'SMS_NOT_CONFIGURED', '인증번호 문자 발송 설정이 완료되지 않았습니다. 관리자에게 문의해주세요.');
    }

    try {
      const result = await this.client.send({
        from: this.config.solapiSender,
        text: message,
        to: phone,
      });
      const providerMessageId = result?.groupInfo?.groupId;
      if (typeof providerMessageId !== 'string' || !providerMessageId.trim()) {
        throw new AppError(502, 'SMS_SEND_FAILED', '인증번호 문자 발송에 실패했습니다. 잠시 후 다시 시도해주세요.');
      }
      return { providerMessageId };
    } catch {
      throw new AppError(502, 'SMS_SEND_FAILED', '인증번호 문자 발송에 실패했습니다. 잠시 후 다시 시도해주세요.');
    }
  }

  async sendContractMms({ image, recipientPhone }) {
    return this.sendImageMms({ images: [image], recipientPhone, message: '' });
  }

  async sendDocumentMms({ images, recipientPhone }) {
    if (!images?.length || images.length > 3) {
      throw new AppError(400, 'DOCUMENT_IMAGES_REQUIRED', '문자 한 건에는 서류 이미지 1~3개를 첨부할 수 있습니다.');
    }
    return this.sendImageMms({ images, recipientPhone, message: '[싸인짱] 요청하신 서류를 보내드립니다.', timeoutMs: 15_000 });
  }

  async sendImageMms({ images, recipientPhone, message, timeoutMs }) {
    // Verification-code development mode must not mark an unsent contract as sent.
    // Contract delivery always requires a real Aligo request.
    if (!this.isAligoConfigured) {
      throw new AppError(503, 'ALIGO_NOT_CONFIGURED', '알리고 문자 발송 설정이 완료되지 않았습니다.');
    }

    const form = new FormData();
    form.set('key', this.config.aligoApiKey);
    form.set('user_id', this.config.aligoUserId);
    form.set('sender', this.config.aligoSender);
    form.set('receiver', recipientPhone);
    // Contract callers keep an empty message; document callers provide a short label.
    form.set('msg', message);
    form.set('msg_type', 'MMS');
    images.forEach((image, index) => form.set(
      index === 0 ? 'image' : `image${index + 1}`,
      new Blob([image.buffer], { type: image.mimetype }),
      image.originalname || 'signjjang-document.jpg',
    ));

    let payload;
    try {
      const response = await fetch('https://apis.aligo.in/send/', {
        method: 'POST', body: form, ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
      const body = await response.text();
      try {
        payload = JSON.parse(body);
      } catch {
        payload = { message: body };
      }
      if (!response.ok || Number(payload.result_code) !== 1) {
        console.error('[ALIGO] contract MMS failed', payload);
        throw new AppError(502, 'ALIGO_SEND_FAILED', payload.message || '알리고 문자 발송에 실패했습니다.');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      console.error('[ALIGO] contract MMS request failed', error);
      throw new AppError(502, 'ALIGO_UNAVAILABLE', '알리고 문자 발송 서버에 연결하지 못했습니다.');
    }

    return { providerMessageId: String(payload.msg_id ?? payload.message_id ?? '') || null };
  }
}

module.exports = { SmsService };
