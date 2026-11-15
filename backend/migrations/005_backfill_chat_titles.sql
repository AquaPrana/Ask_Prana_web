-- Chats saved by the first Node version kept the title "New conversation"
-- (it never renamed them). Give them the title the app normally sets: the
-- farmer's first question, spaces tidied, first 60 characters.
UPDATE chat_sessions s
JOIN (
  SELECT m.session_id, MIN(m.content) AS content
  FROM chat_messages m
  JOIN (
    SELECT session_id, MIN(created_at) AS first_at
    FROM chat_messages
    WHERE role = 'user' AND TRIM(content) <> ''
    GROUP BY session_id
  ) f ON f.session_id = m.session_id AND m.created_at = f.first_at
  WHERE m.role = 'user' AND TRIM(m.content) <> ''
  GROUP BY m.session_id
) first_question ON first_question.session_id = s.id
SET s.title = LEFT(TRIM(REGEXP_REPLACE(first_question.content, '[[:space:]]+', ' ')), 60)
WHERE s.title = 'New conversation';
