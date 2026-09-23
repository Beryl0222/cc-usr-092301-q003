import { DomainError } from "./errors.js";

// 追加式事件存储：每个 subject（一次提交）独立递增版本，乱序写入直接拒绝，
// 保证"接诊者看到最新资料、历史决策仍可复核"两条都成立。
export class EventStore {
  #events = [];
  #versions = new Map();

  nextVersion(subjectId) {
    return (this.#versions.get(subjectId) ?? 0) + 1;
  }

  append(event) {
    const expected = this.nextVersion(event.subject_id);
    if (event.version !== expected) {
      throw new DomainError("VERSION_CONFLICT", `事件版本冲突：应为 ${expected}，实为 ${event.version}`);
    }
    this.#events.push(Object.freeze({ ...event }));
    this.#versions.set(event.subject_id, event.version);
    return event;
  }

  bySubject(subjectId) {
    return this.#events.filter((event) => event.subject_id === subjectId);
  }

  all() {
    return [...this.#events];
  }
}
