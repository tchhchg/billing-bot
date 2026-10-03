/**
 * 云端模型网关（只做文案润色）。
 *
 * 三道约束：
 *  1. 只接受脱敏载荷（LlmRedactedPayload），不含商户/备注/账户/精确金额
 *  2. 出网前再跑一遍 assertNoForbiddenContent，把当天真实商户名当敏感值兜底校验
 *  3. 任何失败（超时、非 2xx、格式不对、脱敏校验不通过）都返回 null，
 *     调用方回退本地模板——建议绝不因为模型问题而丢失
 */
import { assertNoForbiddenContent, type LlmRedactedPayload } from '../../domain/advice/redact.ts';
import type { LlmRepo } from '../db/llmRepo.ts';

export interface LlmGatewayOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 每次调用的最大输出字符数（防止模型啰嗦） */
  maxChars?: number;
}

export interface PolishResult {
  ok: boolean;
  text?: string;
  error?: string;
  latencyMs: number;
}

export interface LlmGateway {
  readonly provider: string;
  polish(args: { payload: LlmRedactedPayload; templateText: string; forbiddenValues?: readonly string[] }): Promise<PolishResult>;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

const SYSTEM_PROMPT =
  '你是记账助手的文案润色器。只能改写用户提供的本地模板文字，使其更自然口语化。' +
  '严禁新增任何数字、金额、商户名、投资理财建议或收益承诺。' +
  '字数不超过原模板的两倍，只输出改写后的正文，不要解释。';

export function createLlmGateway(options: LlmGatewayOptions): LlmGateway {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const provider = options.provider ?? new URL(baseUrl).host;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxChars = options.maxChars ?? 400;

  return {
    provider,

    async polish(args): Promise<PolishResult> {
      const started = Date.now();
      const finish = (ok: boolean, text?: string, error?: string): PolishResult => ({
        ok,
        text,
        error,
        latencyMs: Date.now() - started,
      });

      try {
        // 出网前最后一道闸：连当天的真实商户名都当成敏感值扫一遍
        assertNoForbiddenContent(args.payload, args.forbiddenValues ?? []);
      } catch (error) {
        return finish(false, undefined, error instanceof Error ? error.message : String(error));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            temperature: 0.2,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              {
                role: 'user',
                content: `模板：${args.templateText}\n数据（已脱敏）：${JSON.stringify(args.payload)}`,
              },
            ],
          }),
          signal: controller.signal,
        });
        if (!response.ok) return finish(false, undefined, `模型服务返回 HTTP ${response.status}`);
        const payload = (await response.json()) as ChatResponse;
        const text = payload.choices?.[0]?.message?.content?.trim();
        if (!text) return finish(false, undefined, payload.error?.message ?? '模型返回为空');
        return finish(true, text.slice(0, maxChars));
      } catch (error) {
        return finish(false, undefined, error instanceof Error ? error.message : String(error));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 带留痕的润色：无论成功失败都写 llm_call_log，设置页可查可清 */
export async function polishWithLogging(args: {
  gateway: LlmGateway;
  llmRepo: LlmRepo;
  payload: LlmRedactedPayload;
  templateText: string;
  forbiddenValues?: readonly string[];
  now?: () => Date;
}): Promise<PolishResult> {
  const result = await args.gateway.polish({
    payload: args.payload,
    templateText: args.templateText,
    forbiddenValues: args.forbiddenValues,
  });
  const now = args.now ?? ((): Date => new Date());
  args.llmRepo.log(
    {
      purpose: 'advice_polish',
      redactedPayload: JSON.stringify(args.payload),
      provider: args.gateway.provider,
      ok: result.ok,
      latencyMs: result.latencyMs,
    },
    now().toISOString(),
  );
  return result;
}
