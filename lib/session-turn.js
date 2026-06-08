import { normalizeToolName, safeText } from "./helpers.js";

export class SessionTurn {
  constructor(sessionPath) {
    this.sessionPath = sessionPath || "unknown";
    this.startedAt = new Date().toISOString();
    this.lastTouched = Date.now();
    this.tools = [];
    this.pendingTools = new Map();
    this.toolCallCount = 0;
    this.errors = [];
    this.userTexts = [];
    this.assistantText = "";
    this.stopReason = null;
  }

  touch() {
    this.lastTouched = Date.now();
  }

  addTool(toolName) {
    const name = normalizeToolName(toolName);
    if (!name) return;
    this.tools.push(name);
    this.toolCallCount += 1;
    this.touch();
  }

  markToolStart(toolName) {
    const name = normalizeToolName(toolName);
    if (!name) return;
    this.addTool(name);
    this.pendingTools.set(name, (this.pendingTools.get(name) || 0) + 1);
  }

  markToolEnd(toolName) {
    const name = normalizeToolName(toolName);
    if (!name) return;
    const pending = this.pendingTools.get(name) || 0;
    if (pending > 0) {
      if (pending === 1) this.pendingTools.delete(name);
      else this.pendingTools.set(name, pending - 1);
      this.touch();
      return;
    }
    this.addTool(name);
  }

  get pendingCount() {
    return this.pendingTools.size;
  }

  getPendingTools() {
    return new Map(this.pendingTools);
  }

  addError(message) {
    const text = safeText(message);
    if (text) this.errors.push(text);
    this.touch();
  }

  addUserText(text) {
    const clean = safeText(text, 300);
    if (clean) this.userTexts.push(clean);
    this.touch();
  }
}
