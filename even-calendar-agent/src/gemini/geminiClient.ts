import { GoogleGenAI } from '@google/genai';
import { EVENT_CANDIDATE_RESPONSE_SCHEMA } from './eventCandidateSchema.js';
import { FOLLOWUP_RESULT_RESPONSE_SCHEMA } from './followupResultSchema.js';
import { EDIT_INSTRUCTION_RESPONSE_SCHEMA } from './editInstructionSchema.js';

export interface GenerateEventCandidateParams {
  audioBase64: string;
  systemInstruction: string;
  abortSignal: AbortSignal;
}

/**
 * Gemini呼び出しの最小インターフェース。テストではFakeGeminiClientを注入し、
 * 実Vertex AIを一切呼ばない。
 */
export interface GeminiClient {
  generateEventCandidateJson(params: GenerateEventCandidateParams): Promise<string | undefined>;
  /** 追加入力(follow-up)音声解析専用。cancelledを含む別スキーマを使う点だけが異なる。 */
  generateFollowupResultJson(params: GenerateEventCandidateParams): Promise<string | undefined>;
  /** 既存予定の編集指示(analyze-edit-audio)専用。fields差分スキーマを使う点だけが異なる。 */
  generateEditInstructionJson(params: GenerateEventCandidateParams): Promise<string | undefined>;
}

export interface VertexGeminiClientConfig {
  project: string;
  location: string;
  model: string;
}

/**
 * @google/genai を vertexai:true で使用する実装。ApplicationDefaultCredentials
 * (Cloud Run実行サービスアカウント)で認証する。APIキーは一切使用・保持しない。
 */
export class VertexGeminiClient implements GeminiClient {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(config: VertexGeminiClientConfig) {
    this.ai = new GoogleGenAI({
      vertexai: true,
      project: config.project,
      location: config.location,
    });
    this.model = config.model;
  }

  async generateEventCandidateJson(params: GenerateEventCandidateParams): Promise<string | undefined> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'audio/wav', data: params.audioBase64 } }],
        },
      ],
      config: {
        systemInstruction: params.systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: EVENT_CANDIDATE_RESPONSE_SCHEMA,
        abortSignal: params.abortSignal,
      },
    });

    return response.text;
  }

  async generateFollowupResultJson(params: GenerateEventCandidateParams): Promise<string | undefined> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'audio/wav', data: params.audioBase64 } }],
        },
      ],
      config: {
        systemInstruction: params.systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: FOLLOWUP_RESULT_RESPONSE_SCHEMA,
        abortSignal: params.abortSignal,
      },
    });

    return response.text;
  }

  async generateEditInstructionJson(params: GenerateEventCandidateParams): Promise<string | undefined> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'audio/wav', data: params.audioBase64 } }],
        },
      ],
      config: {
        systemInstruction: params.systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: EDIT_INSTRUCTION_RESPONSE_SCHEMA,
        abortSignal: params.abortSignal,
      },
    });

    return response.text;
  }
}

/** テスト・ローカル疎通確認用のFake。実Vertex AIへは一切アクセスしない。 */
export class FakeGeminiClient implements GeminiClient {
  public calls: GenerateEventCandidateParams[] = [];
  public followupCalls: GenerateEventCandidateParams[] = [];
  public editCalls: GenerateEventCandidateParams[] = [];
  public responseJson: string | undefined = JSON.stringify({
    schemaVersion: '1',
    resultType: 'not_calendar_request',
    title: null,
    dateLocal: null,
    startTimeLocal: null,
    durationMinutes: null,
    timeZone: 'Asia/Tokyo',
    allDay: false,
    explicitCorrection: false,
    clarificationField: null,
    clarificationQuestion: null,
    assumptions: [],
  });
  public followupResponseJson: string | undefined = this.responseJson;
  public editResponseJson: string | undefined = JSON.stringify({
    schemaVersion: '1',
    resultType: 'not_understood',
    title: null,
    location: null,
    description: null,
    startLocal: null,
    endLocal: null,
    allDay: null,
    startDate: null,
    endDateExclusive: null,
  });
  public shouldThrow: Error | null = null;
  public abortOnCall = false;

  async generateEventCandidateJson(params: GenerateEventCandidateParams): Promise<string | undefined> {
    this.calls.push(params);
    if (this.abortOnCall) {
      return new Promise((_resolve, reject) => {
        params.abortSignal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    if (this.shouldThrow) {
      throw this.shouldThrow;
    }
    return this.responseJson;
  }

  async generateFollowupResultJson(params: GenerateEventCandidateParams): Promise<string | undefined> {
    this.followupCalls.push(params);
    if (this.abortOnCall) {
      return new Promise((_resolve, reject) => {
        params.abortSignal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    if (this.shouldThrow) {
      throw this.shouldThrow;
    }
    return this.followupResponseJson;
  }

  async generateEditInstructionJson(params: GenerateEventCandidateParams): Promise<string | undefined> {
    this.editCalls.push(params);
    if (this.abortOnCall) {
      return new Promise((_resolve, reject) => {
        params.abortSignal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    if (this.shouldThrow) {
      throw this.shouldThrow;
    }
    return this.editResponseJson;
  }
}
