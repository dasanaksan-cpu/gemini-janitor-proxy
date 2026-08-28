export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const body = req.body || {};
    const isStream = body.stream === true;
    const rawModel = body.model || 'gemini-1.5-flash';
    const model = String(rawModel).replace(/^models\//, '').trim();

    let systemInstructionText = "";
    let contents = [];
    let userName = "User";

    for (const msg of body.messages || []) {
      if (msg.role === 'system') {
        systemInstructionText += msg.content + "\n";
        const match = msg.content.match(/(?:User|{{user}}):\s*([^\n]+)/i);
        if (match) userName = match[1].trim();
      } else {
        const mappedRole = msg.role === 'assistant' ? 'model' : 'user';
        if (contents.length > 0 && contents[contents.length - 1].role === mappedRole) {
          contents[contents.length - 1].parts[0].text += "\n\n" + msg.content;
        } else {
          contents.push({ role: mappedRole, parts: [{ text: msg.content }] });
        }
      }
    }

    if (contents.length > 0 && contents[0].role === 'model') {
      contents.unshift({ role: 'user', parts: [{ text: '...' }] });
    }

    const geminiPayload = {
      contents: contents,
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
      ],
      generationConfig: {
        temperature: body.temperature && body.temperature > 0.6 ? body.temperature : 0.92,
        topP: (body.top_p && body.top_p > 0) ? body.top_p : 0.95,
        topK: (body.top_k && body.top_k > 0) ? body.top_k : 64,
        maxOutputTokens: body.max_tokens || 8192,
        stopSequences: [`\n${userName}:`, `\nUser:`]
      }
    };

    if (systemInstructionText.trim() !== "") {
      geminiPayload.systemInstruction = { parts: [{ text: systemInstructionText.trim() }] };
    }

    const authHeader = req.headers['authorization'] || '';
    const apiKey = authHeader.replace('Bearer ', '').trim();

    const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${isStream ? 'streamGenerateContent?alt=sse&' : 'generateContent?'}key=${apiKey}`;

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiPayload)
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(400).json({ error: { message: err.error?.message || "Google API Error" } });
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.replace('data: ', '').trim();
            if (!dataStr) continue;
            try {
              const dataObj = JSON.parse(dataStr);
              let textPart = "";
              if (dataObj.candidates?.[0]?.content?.parts) {
                for (const part of dataObj.candidates[0].content.parts) {
                  if (part.text && !part.thought) textPart += part.text;
                }
              }
              if (textPart) {
                const chunk = {
                  id: "chatcmpl-" + Date.now(),
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{ index: 0, delta: { content: textPart }, finish_reason: null }]
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            } catch (e) {}
          }
        }
      }
      res.write("data: [DONE]\n\n");
      return res.end();
    } else {
      const data = await response.json();
      let replyText = "";
      for (const part of data.candidates?.[0]?.content?.parts || []) {
        if (part.text && !part.thought) replyText += part.text;
      }

      return res.status(200).json({
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" }]
      });
    }
  } catch (e) {
    return res.status(500).json({ error: { message: e.message } });
  }
}
