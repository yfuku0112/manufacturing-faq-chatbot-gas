/**
 * 製造現場FAQチャットボット
 * Manufacturing FAQ Chatbot
 *
 * 処理の流れ / Processing flow:
 * 1. ユーザーの質問を受け取る
 * 2. FAQのキーワードで検索する
 * 3. 見つからない場合はGeminiで意味検索する
 * 4. 検索結果をChatLogsシートへ記録する
 */


/**
 * Webアプリを表示する。
 * Displays the chatbot web application.
 *
 * @return {HtmlOutput} チャット画面 / Chat screen
 */
function doGet() {
  return HtmlService
    .createHtmlOutputFromFile('Index')
    .setTitle('製造サポートアシスタント');
}


/**
 * ユーザーの質問に対応するFAQを検索する。
 * Searches for an FAQ that matches the user's question.
 *
 * @param {string} userQuestion ユーザーの質問 / User question
 * @return {Object} 検索結果 / Search result
 */
function searchFaq(userQuestion) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const faqSheet = spreadsheet.getSheetByName('FAQ');
  const logSheet = spreadsheet.getSheetByName('ChatLogs');

  // 必要なシートが存在するか確認する。
  // Check whether the required sheets exist.
  if (!faqSheet || !logSheet) {
    throw new Error(
      'FAQまたはChatLogsシートが見つかりません。'
    );
  }

  const normalizedQuestion = normalizeText(userQuestion);

  // 質問が空欄の場合は検索しない。
  // Do not search when the question is empty.
  if (!normalizedQuestion) {
    return {
      matched: false,
      answer: '質問を入力してください。',
      faqId: ''
    };
  }

  const faqData = getFaqData(faqSheet);

  // 最初に通常のキーワード検索を行う。
  // First, perform the keyword search.
  const keywordResult = searchByKeyword(
    normalizedQuestion,
    faqData
  );

  if (keywordResult.matched) {
    writeChatLog(
      logSheet,
      userQuestion,
      keywordResult.answer,
      keywordResult.faqId,
      '解決候補あり（キーワード検索）'
    );

    return keywordResult;
  }

  // キーワード検索で見つからない場合はGeminiを使用する。
  // Use Gemini when the keyword search finds no match.
  try {
    const geminiResult = searchByGemini(
      userQuestion,
      faqData
    );

    if (geminiResult.matched) {
      writeChatLog(
        logSheet,
        userQuestion,
        geminiResult.answer,
        geminiResult.faqId,
        '解決候補あり（Gemini）'
      );

      return geminiResult;
    }
  } catch (error) {
    // Geminiでエラーが発生してもアプリ全体は停止させない。
    // Keep the application running even if Gemini fails.
    console.error(
      'Gemini API error: ' + error.message
    );
  }

  const unresolvedMessage =
    getUnresolvedMessage(spreadsheet);

  writeChatLog(
    logSheet,
    userQuestion,
    unresolvedMessage,
    '',
    '未解決'
  );

  return {
    matched: false,
    answer: unresolvedMessage,
    faqId: ''
  };
}


/**
 * FAQシートからデータを取得する。
 * Retrieves FAQ records from the FAQ sheet.
 *
 * FAQシートの列構成 / FAQ sheet columns:
 * A: FAQ_ID
 * B: カテゴリ
 * C: 質問
 * D: 回答
 * E: 検索キーワード
 *
 * @param {Sheet} faqSheet FAQシート / FAQ sheet
 * @return {Object[]} FAQデータ / FAQ records
 */
function getFaqData(faqSheet) {
  const lastRow = faqSheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  const values = faqSheet
    .getRange(
      2,
      1,
      lastRow - 1,
      5
    )
    .getDisplayValues();

  return values.map(function(row) {
    return {
      faqId: row[0],
      category: row[1],
      question: row[2],
      answer: row[3],
      keywords: row[4]
    };
  });
}


/**
 * 質問文とFAQのキーワードを比較する。
 * Compares the user's question with FAQ keywords.
 *
 * @param {string} normalizedQuestion 正規化済みの質問
 * @param {Object[]} faqData FAQデータ
 * @return {Object} 検索結果 / Search result
 */
function searchByKeyword(
  normalizedQuestion,
  faqData
) {
  let bestFaq = null;
  let bestScore = 0;

  faqData.forEach(function(faq) {
    let score = 0;

    const normalizedFaqQuestion =
      normalizeText(faq.question);

    // FAQの質問文と入力内容が近い場合は高得点にする。
    // Give a high score when the FAQ question matches.
    if (
      normalizedQuestion.includes(
        normalizedFaqQuestion
      ) ||
      normalizedFaqQuestion.includes(
        normalizedQuestion
      )
    ) {
      score += 10;
    }

    // 「、」「,」で区切った検索キーワードを比較する。
    // Compare keywords separated by commas.
    const keywords = String(faq.keywords || '')
      .split(/[、,]/)
      .map(function(keyword) {
        return normalizeText(keyword);
      })
      .filter(function(keyword) {
        return keyword !== '';
      });

    keywords.forEach(function(keyword) {
      if (normalizedQuestion.includes(keyword)) {
        score += 2;
      }
    });

    if (score > bestScore) {
      bestScore = score;
      bestFaq = faq;
    }
  });

  // 2点以上の場合だけ検索結果として採用する。
  // Accept the result only when the score is 2 or more.
  if (bestFaq && bestScore >= 2) {
    return {
      matched: true,
      answer: bestFaq.answer,
      faqId: bestFaq.faqId
    };
  }

  return {
    matched: false,
    answer: '',
    faqId: ''
  };
}


/**
 * Geminiを使用して質問とFAQの意味的な一致を判定する。
 * Uses Gemini to find a semantic FAQ match.
 *
 * @param {string} userQuestion ユーザーの質問
 * @param {Object[]} faqData FAQデータ
 * @return {Object} Geminiによる検索結果
 */
function searchByGemini(
  userQuestion,
  faqData
) {
  // スクリプトプロパティからAPIキーを取得する。
  // Read the API key from Script Properties.
  const apiKey = PropertiesService
    .getScriptProperties()
    .getProperty('GEMINI_API_KEY');

  if (!apiKey) {
    throw new Error(
      'スクリプトプロパティ「GEMINI_API_KEY」' +
      'が設定されていません。'
    );
  }

  if (faqData.length === 0) {
    return {
      matched: false,
      answer: '',
      faqId: ''
    };
  }

  // Geminiへ渡すFAQ一覧を作成する。
  // Build the FAQ list supplied to Gemini.
  const faqText = faqData
    .map(function(faq) {
      return [
        'FAQ_ID: ' + faq.faqId,
        'カテゴリ: ' + faq.category,
        '質問: ' + faq.question,
        '回答: ' + faq.answer,
        '検索キーワード: ' + faq.keywords
      ].join('\n');
    })
    .join('\n\n---\n\n');

  // Geminiへ渡す指示文を作成する。
  // Build the prompt sent to Gemini.
  const prompt = [
    'あなたは製造現場向けFAQ検索アシスタントです。',
    'ユーザーの質問とFAQ一覧を比較してください。',
    '',
    '【重要なルール】',
    '・FAQに記載された情報だけを使用してください。',
    '・FAQにない情報を推測または創作しないでください。',
    '・意味が一致するFAQがある場合は、',
    '　そのFAQ_IDを返してください。',
    '・一致するFAQがない場合は、',
    '　faqIdを空文字にしてください。',
    '・最も近いFAQを1件だけ選んでください。',
    '',
    '【ユーザーの質問】',
    userQuestion,
    '',
    '【FAQ一覧】',
    faqText
  ].join('\n');

  const modelName = 'gemini-3.1-flash-lite';

  const url =
    'https://generativelanguage.googleapis.com/' +
    'v1beta/models/' +
    modelName +
    ':generateContent?key=' +
    encodeURIComponent(apiKey);

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          faqId: {
            type: 'STRING',
            description:
              '一致したFAQ_ID。' +
              '一致しない場合は空文字。'
          }
        },
        required: [
          'faqId'
        ]
      }
    }
  };

  // Gemini APIへHTTPリクエストを送信する。
  // Send the HTTP request to the Gemini API.
  const response = UrlFetchApp.fetch(
    url,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(requestBody),
      muteHttpExceptions: true
    }
  );

  const statusCode = response.getResponseCode();
  const responseText = response.getContentText();

  // HTTPエラーの場合は詳細情報を出力する。
  // Throw detailed information for HTTP errors.
  if (
    statusCode < 200 ||
    statusCode >= 300
  ) {
    throw new Error(
      'Gemini APIの呼び出しに失敗しました。' +
      ' ステータスコード: ' +
      statusCode +
      ' レスポンス: ' +
      responseText
    );
  }

  const responseJson = JSON.parse(responseText);

  // Geminiから回答が返されたか確認する。
  // Verify that Gemini returned content.
  if (
    !responseJson.candidates ||
    responseJson.candidates.length === 0 ||
    !responseJson.candidates[0].content ||
    !responseJson.candidates[0].content.parts ||
    responseJson.candidates[0].content.parts.length === 0
  ) {
    throw new Error(
      'Geminiから回答が返されませんでした。'
    );
  }

  const generatedText =
    responseJson
      .candidates[0]
      .content
      .parts[0]
      .text;

  const generatedResult =
    JSON.parse(generatedText);

  const selectedFaqId = String(
    generatedResult.faqId || ''
  ).trim();

  // Geminiが一致なしと判断した場合。
  // When Gemini determines there is no match.
  if (!selectedFaqId) {
    return {
      matched: false,
      answer: '',
      faqId: ''
    };
  }

  // Geminiが選択したFAQ_IDをFAQ一覧から探す。
  // Find the FAQ ID selected by Gemini.
  const selectedFaq = faqData.find(
    function(faq) {
      return faq.faqId === selectedFaqId;
    }
  );

  // 存在しないFAQ_IDは採用しない。
  // Reject FAQ IDs that do not exist.
  if (!selectedFaq) {
    return {
      matched: false,
      answer: '',
      faqId: ''
    };
  }

  // 回答文はGeminiに作らせず、FAQシートから取得する。
  // Return the trusted answer stored in the FAQ sheet.
  return {
    matched: true,
    answer: selectedFaq.answer,
    faqId: selectedFaq.faqId
  };
}


/**
 * Settingsシートから未解決時のメッセージを取得する。
 * Gets the fallback message from the Settings sheet.
 *
 * @param {Spreadsheet} spreadsheet 対象スプレッドシート
 * @return {string} 未解決時のメッセージ
 */
function getUnresolvedMessage(spreadsheet) {
  const defaultMessage =
    '該当するFAQが見つかりませんでした。' +
    '発生日時、対象設備、エラー内容を記録して' +
    '担当者へ確認してください。';

  const settingsSheet =
    spreadsheet.getSheetByName('Settings');

  if (
    !settingsSheet ||
    settingsSheet.getLastRow() < 2
  ) {
    return defaultMessage;
  }

  const settingsData = settingsSheet
    .getRange(
      2,
      1,
      settingsSheet.getLastRow() - 1,
      2
    )
    .getDisplayValues();

  for (
    let index = 0;
    index < settingsData.length;
    index++
  ) {
    const settingName =
      settingsData[index][0];

    const settingValue =
      settingsData[index][1];

    if (
      settingName === '未解決時メッセージ' ||
      settingName === '該当なしメッセージ'
    ) {
      return settingValue || defaultMessage;
    }
  }

  return defaultMessage;
}


/**
 * 質問と回答をChatLogsシートへ記録する。
 * Writes the result to the ChatLogs sheet.
 *
 * @param {Sheet} logSheet ChatLogsシート
 * @param {string} question 質問
 * @param {string} answer 回答
 * @param {string} faqId 参照FAQ_ID
 * @param {string} result 回答結果
 */
function writeChatLog(
  logSheet,
  question,
  answer,
  faqId,
  result
) {
  logSheet.appendRow([
    new Date(),
    question,
    answer,
    faqId,
    result
  ]);
}


/**
 * 検索しやすいように文字列を正規化する。
 * Normalizes text to improve matching.
 *
 * 処理内容 / Processing:
 * ・小文字へ変換
 * ・全角英数字を半角へ変換
 * ・空白と記号を削除
 *
 * @param {*} value 正規化する値
 * @return {string} 正規化済み文字列
 */
function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(
      /[Ａ-Ｚａ-ｚ０-９]/g,
      function(character) {
        return String.fromCharCode(
          character.charCodeAt(0) - 0xFEE0
        );
      }
    )
    // 空白を削除する。
    // Remove whitespace.
    .replace(
      /\s/g,
      ''
    )
    // スラッシュ以外の記号を削除する。
    // Remove symbols except slashes.
    .replace(
      /[、。,.!?！？・「」『』（）()【】：:／ー\-\[\]]/g,
      ''
    )
    // 半角スラッシュを削除する。
    // Remove half-width slashes.
    .replace(
      /\//g,
      ''
    );
}


/**
 * Geminiとの接続を単独で確認する。
 * Tests the Gemini connection independently.
 *
 * この関数はWeb画面からは使用しない。
 * Run this function manually from the editor.
 */
function testGeminiConnection() {
  const spreadsheet =
    SpreadsheetApp.getActiveSpreadsheet();

  const faqSheet =
    spreadsheet.getSheetByName('FAQ');

  if (!faqSheet) {
    throw new Error(
      'FAQシートが見つかりません。'
    );
  }

  const faqData = getFaqData(faqSheet);

  const result = searchByGemini(
    'スイッチを押しても装置に' +
    'まったく通電していないようです',
    faqData
  );

  console.log(
    JSON.stringify(result)
  );
}
