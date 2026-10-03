/** 推送当前日报（强制重算），并打印每个渠道的真实结果。排查推送问题时用它。 */
import { createApp } from '../src/main.ts';

const app = await createApp({ withServer: false, withScheduler: false, log: (m) => console.log(m) });
console.log(`渠道：${app.channels().map((c) => c.id).join('、')}`);
console.log(`接收人：${app.settings().host.receiveId || '(未设置)'}`);

const outcome = await app.runDaily({ force: true });
console.log(`状态：${outcome.status}｜日期：${outcome.localDate}｜建议 ${outcome.advices?.length ?? 0} 条`);
for (const result of outcome.results ?? []) {
  console.log(`  ${result.ok ? '✅' : '❌'} ${result.channel}：${result.detail ?? ''}（${result.latencyMs ?? 0}ms）`);
}
await app.close();
