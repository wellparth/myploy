import chalk from 'chalk';

export type DiagnosticCategory =
  | 'DATABASE_CONNECTION'
  | 'MISSING_ENV'
  | 'PORT_IN_USE'
  | 'OUT_OF_MEMORY'
  | 'MISSING_DEPENDENCY'
  | 'SYNTAX_ERROR'
  | 'UNKNOWN';

export interface DiagnosticReport {
  category: DiagnosticCategory;
  title: string;
  rootCause: string;
  suggestedFix: string;
  confidence: 'high' | 'medium' | 'low';
  diagnosedBy: 'heuristic-rules' | 'ai-llm';
  matchedSnippet?: string;
}

/**
 * Analyzes container logs and exit status using rule-based pattern matching
 * to immediately diagnose the root cause of a candidate container boot failure.
 */
export function analyzeLogsWithHeuristics(
  logs: string,
  exitCode?: number | string
): DiagnosticReport {
  const normalizedLogs = logs || '';

  // 1. Out of Memory (OOM Kill / Exit 137)
  if (
    String(exitCode) === '137' ||
    /out of memory|javascript heap out of memory|runtime: out of memory|killed/i.test(
      normalizedLogs
    )
  ) {
    const match = normalizedLogs.match(
      /(?:out of memory|javascript heap out of memory|runtime: out of memory|killed)[^\n]*/i
    );
    return {
      category: 'OUT_OF_MEMORY',
      title: 'Container Out-Of-Memory (OOM) Termination',
      rootCause:
        'The container exceeded the host or cgroup memory limit and was terminated by the Linux OOM killer (Exit 137).',
      suggestedFix:
        'Increase host VPS RAM, configure swap space (e.g. 2GB swapfile), or optimize container memory limits in docker-compose.yml.',
      confidence: 'high',
      diagnosedBy: 'heuristic-rules',
      matchedSnippet: match ? match[0].trim() : undefined
    };
  }

  // 2. Database Connection Errors (Host localhost vs container network)
  const dbLocalhostMatch = normalizedLogs.match(
    /(?:econnrefused\s+(?:127\.0\.0\.1|localhost)|connect\s+econnrefused\s+(?:127\.0\.0\.1|localhost)|can't reach database server at\s+`localhost|can't reach database server at\s+`127\.0\.0\.1)/i
  );
  if (dbLocalhostMatch) {
    return {
      category: 'DATABASE_CONNECTION',
      title: 'Database Connection Refused (Localhost Misconfiguration)',
      rootCause:
        'Application attempted to connect to a database at localhost / 127.0.0.1 inside the container instead of the internal Docker bridge network.',
      suggestedFix:
        'Inside Docker, "localhost" points to the container itself. Set DATABASE_URL or host to the internal service name (e.g. "postgres", "mysql") on the shared myploy network.',
      confidence: 'high',
      diagnosedBy: 'heuristic-rules',
      matchedSnippet: dbLocalhostMatch[0].trim()
    };
  }

  const dbGeneralMatch = normalizedLogs.match(
    /(?:p1001|mongoserverselectionerror|sequelizeconnectionrefusederror|econnrefused\s+[\w.-]+:\d+|password authentication failed|access denied for user|no pg_hba\.conf entry)/i
  );
  if (dbGeneralMatch) {
    const isAuth = /password authentication failed|access denied for user/i.test(
      normalizedLogs
    );
    return {
      category: 'DATABASE_CONNECTION',
      title: isAuth
        ? 'Database Authentication Failed'
        : 'Database Connection Failed',
      rootCause: isAuth
        ? 'Database rejected connection credentials (incorrect user, password, or database name).'
        : `Could not establish TCP connection to database server: ${dbGeneralMatch[0]}`,
      suggestedFix: isAuth
        ? 'Verify database user, password, and database name in your environment file.'
        : 'Ensure database container is running and healthy via "myploy db list", and verify network attachment in docker-compose.yml.',
      confidence: 'high',
      diagnosedBy: 'heuristic-rules',
      matchedSnippet: dbGeneralMatch[0].trim()
    };
  }

  // 3. Missing Required Environment Variables
  const envVarMatch = normalizedLogs.match(
    /(?:environment variable not found:\s*([\w_]+)|keyerror:\s*['"]([\w_]+)['"]|missing required environment variable:\s*([\w_]+)|env validation failed|zoderror)/i
  );
  if (envVarMatch) {
    const varName = envVarMatch[1] || envVarMatch[2] || envVarMatch[3];
    return {
      category: 'MISSING_ENV',
      title: 'Missing Required Environment Variable',
      rootCause: varName
        ? `Application failed to start because required environment variable "${varName}" is missing.`
        : 'Application configuration validation failed due to missing environment variables.',
      suggestedFix:
        'Ensure all required keys are defined in your .env file and specify "envFile" in myploy.json.',
      confidence: 'high',
      diagnosedBy: 'heuristic-rules',
      matchedSnippet: envVarMatch[0].trim()
    };
  }

  // 4. Port Conflict / Address In Use
  const portMatch = normalizedLogs.match(
    /(?:eaddrinuse|address already in use|bind: address already in use)[^\n]*/i
  );
  if (portMatch) {
    return {
      category: 'PORT_IN_USE',
      title: 'Port Already In Use (EADDRINUSE)',
      rootCause:
        'The application attempted to bind to a network port that is already occupied by another running process or container.',
      suggestedFix:
        'Ensure the application listens on the port configured in "appPort" in myploy.json, and check that candidate port mapping does not conflict with host ports.',
      confidence: 'high',
      diagnosedBy: 'heuristic-rules',
      matchedSnippet: portMatch[0].trim()
    };
  }

  // 5. Missing Runtime Dependencies / Modules
  const moduleMatch = normalizedLogs.match(
    /(?:cannot find module\s*['"]([^'"]+)['"]|modulenotfounderror:\s*no module named\s*['"]?([\w._-]+)['"]?)/i
  );
  if (moduleMatch) {
    const missingModule = moduleMatch[1] || moduleMatch[2];
    return {
      category: 'MISSING_DEPENDENCY',
      title: 'Missing Application Dependency',
      rootCause: `Runtime failed to find required module: "${missingModule}".`,
      suggestedFix:
        'Ensure the dependency is declared in package.json / requirements.txt and that Dockerfile runs the dependency install step in production builds.',
      confidence: 'high',
      diagnosedBy: 'heuristic-rules',
      matchedSnippet: moduleMatch[0].trim()
    };
  }

  // 6. Syntax or Unhandled Runtime Exceptions
  const syntaxMatch = normalizedLogs.match(
    /(?:syntaxerror|typeerror|referenceerror|unhandledpromiserejection)[^\n]*/i
  );
  if (syntaxMatch) {
    return {
      category: 'SYNTAX_ERROR',
      title: 'Application Runtime Crash on Startup',
      rootCause: `Application crashed during initialization: ${syntaxMatch[0].trim()}`,
      suggestedFix:
        'Review recent code changes and verify application starts cleanly in a local container environment before deploying.',
      confidence: 'medium',
      diagnosedBy: 'heuristic-rules',
      matchedSnippet: syntaxMatch[0].trim()
    };
  }

  // 7. Fallback Unknown
  return {
    category: 'UNKNOWN',
    title: 'Candidate Service Healthcheck Failure',
    rootCause:
      'The container did not crash immediately, but the HTTP /health endpoint failed to return HTTP 200 OK before the timeout expired.',
    suggestedFix:
      'Verify that the application actively listens on the port specified in "appPort" (binding to 0.0.0.0, not 127.0.0.1) and that the "/health" route responds with 200 OK.',
    confidence: 'low',
    diagnosedBy: 'heuristic-rules'
  };
}

/**
 * Optional LLM query helper with strict 4-second timeout.
 * Gracefully falls back to heuristic triage if unavailable, timed out, or unconfigured.
 */
export async function queryLlmDiagnostics(
  logs: string,
  exitCode?: number | string
): Promise<DiagnosticReport | null> {
  const apiKey =
    process.env.MYPLOY_AI_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GROQ_API_KEY;

  if (!apiKey) {
    return null;
  }

  const endpoint = process.env.GROQ_API_KEY
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';

  const model = process.env.GROQ_API_KEY ? 'llama-3.1-8b-instant' : 'gpt-4o-mini';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    const prompt = `You are an automated DevOps SRE container diagnostician. A Docker container failed healthcheck during blue/green deployment.
Exit Code: ${exitCode ?? 'none'}
Container Logs (tail 50 lines):
${logs.slice(-2500)}

Analyze the root cause and provide a JSON response with exactly these keys:
{
  "category": "DATABASE_CONNECTION" | "MISSING_ENV" | "PORT_IN_USE" | "OUT_OF_MEMORY" | "MISSING_DEPENDENCY" | "SYNTAX_ERROR" | "UNKNOWN",
  "title": "Short title",
  "rootCause": "1-2 sentence root cause explanation",
  "suggestedFix": "1-2 sentence actionable fix",
  "confidence": "high" | "medium" | "low"
}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as DiagnosticReport;
    if (parsed.title && parsed.rootCause && parsed.suggestedFix) {
      return {
        ...parsed,
        diagnosedBy: 'ai-llm'
      };
    }
    return null;
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

/**
 * Main entrypoint for post-mortem diagnostics.
 * Tries LLM analysis first if API key is configured, falling back to heuristics.
 */
export async function diagnoseContainerFailure(
  logs: string,
  exitCode?: number | string
): Promise<DiagnosticReport> {
  const llmReport = await queryLlmDiagnostics(logs, exitCode);
  if (llmReport) {
    return llmReport;
  }
  return analyzeLogsWithHeuristics(logs, exitCode);
}

/**
 * Prints a clean, colorized SRE diagnostic card to the terminal.
 */
export function printDiagnosticReport(report: DiagnosticReport): void {
  const width = 68;
  const border = '─'.repeat(width);

  console.log();
  console.log(chalk.bold.red(`┌${border}┐`));
  console.log(
    chalk.bold.red('│') +
      chalk.bold.yellow(' 🤖 MyPloy Automated Failure Triage & Post-Mortem'.padEnd(width)) +
      chalk.bold.red('│')
  );
  console.log(chalk.bold.red(`├${border}┤`));

  console.log(
    `${chalk.bold.red('│')} ${chalk.bold.white('Category:')}    ${chalk.cyan(
      report.title
    )}`
  );

  console.log(
    `${chalk.bold.red('│')} ${chalk.bold.white('Root Cause:')}  ${chalk.white(
      report.rootCause
    )}`
  );

  console.log(
    `${chalk.bold.red('│')} ${chalk.bold.white('Action Fix:')}  ${chalk.greenBright(
      report.suggestedFix
    )}`
  );

  if (report.matchedSnippet) {
    console.log(
      `${chalk.bold.red('│')} ${chalk.bold.white('Log Match:')}   ${chalk.dim(
        report.matchedSnippet.slice(0, 56)
      )}`
    );
  }

  const footer = `Engine: ${report.diagnosedBy} (${report.confidence} confidence)`;
  console.log(`${chalk.bold.red('│')} ${chalk.dim(footer)}`);
  console.log(chalk.bold.red(`└${border}┘`));
  console.log();
}
