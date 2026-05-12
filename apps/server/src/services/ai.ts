import { generateText, streamText, type LanguageModel } from 'ai';
import type { LLMMessage } from './context';
import { DEFAULT_MODEL_ID, resolveModel } from './models';
import type {
  GenerationSpan,
  PhaseSpan,
  ResearchTrace,
  StartGenerationOptions,
} from './tracing';

export function defaultModel(): LanguageModel {
  return resolveModel(DEFAULT_MODEL_ID);
}

export interface AssistantTextStream {
  textStream: AsyncIterable<string>;
}

function extractSystemPrompt(messages: LLMMessage[]): {
  system: string | undefined;
  nonSystemMessages: LLMMessage[];
} {
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');
  const system =
    systemMessages.length > 0
      ? systemMessages.map((m) => m.content).join('\n\n')
      : undefined;
  return { system, nonSystemMessages };
}

export function streamAssistantText(
  messages: LLMMessage[],
  modelId: string = DEFAULT_MODEL_ID,
  abortSignal?: AbortSignal,
): AssistantTextStream {
  const { system, nonSystemMessages } = extractSystemPrompt(messages);
  return streamText({
    model: resolveModel(modelId),
    system,
    messages: nonSystemMessages,
    abortSignal,
  });
}

// Anything with a startGeneration() method can parent a generation. The trace
// itself and any phase span both satisfy this.
export type TracingContext = ResearchTrace | PhaseSpan;

export interface GenerateAssistantTextOptions {
  trace?: TracingContext;
  generationName?: string;
  generationMetadata?: Record<string, unknown>;
}

export async function generateAssistantText(
  messages: LLMMessage[],
  modelId: string = DEFAULT_MODEL_ID,
  options: GenerateAssistantTextOptions = {},
): Promise<string> {
  const generation = startGeneration(modelId, messages, options);
  try {
    const { system, nonSystemMessages } = extractSystemPrompt(messages);
    const result = await generateText({
      model: resolveModel(modelId),
      system,
      messages: nonSystemMessages,
    });
    generation?.end({
      output: result.text,
      usage: {
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        totalTokens: result.usage?.totalTokens,
      },
    });
    return result.text;
  } catch (err) {
    generation?.end({
      level: 'ERROR',
      statusMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function startGeneration(
  modelId: string,
  messages: LLMMessage[],
  options: GenerateAssistantTextOptions,
): GenerationSpan | null {
  const parent = options.trace;
  if (!parent) return null;
  const opts: StartGenerationOptions = {
    modelId,
    input: messages,
    metadata: options.generationMetadata,
  };
  return parent.startGeneration(options.generationName ?? 'llm-call', opts);
}
