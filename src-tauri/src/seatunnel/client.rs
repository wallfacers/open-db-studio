use futures_util::StreamExt;
use reqwest::Client;

/// SeaTunnel REST API 客户端
pub struct SeaTunnelClient {
    base_url: String,
    auth_token: Option<String>,
    client: Client,
}

impl SeaTunnelClient {
    pub fn new(base_url: String, auth_token: Option<String>) -> Self {
        Self {
            base_url,
            auth_token,
            client: Client::new(),
        }
    }

    /// 构建带 Authorization header 的请求构建器
    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let builder = self.client.request(method, url);
        if let Some(token) = &self.auth_token {
            builder.bearer_auth(token)
        } else {
            builder
        }
    }

    /// 提交 Job，POST /api/v1/job/submit，返回 jobId 字符串
    pub async fn submit_job(&self, config_json: &str) -> Result<String, String> {
        let body: serde_json::Value = serde_json::from_str(config_json)
            .map_err(|e| format!("Invalid config JSON: {}", e))?;

        let resp = self
            .request(reqwest::Method::POST, "/api/v1/job/submit")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Failed to submit job: {}", e))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read submit response: {}", e))?;

        if !status.is_success() {
            return Err(format!("Submit job failed ({}): {}", status, text));
        }

        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Invalid submit response JSON: {}", e))?;

        // SeaTunnel 返回 {"jobId": "..."} 或 {"data": {"jobId": "..."}}
        let job_id = json
            .get("jobId")
            .or_else(|| json.get("data").and_then(|d| d.get("jobId")))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("No jobId in response: {}", text))?;

        Ok(job_id)
    }

    /// 查询 Job 状态，GET /api/v1/job/detail/{jobId}，返回 status 字符串
    pub async fn get_job_status(&self, job_id: &str) -> Result<String, String> {
        let path = format!("/api/v1/job/detail/{}", job_id);
        let resp = self
            .request(reqwest::Method::GET, &path)
            .send()
            .await
            .map_err(|e| format!("Failed to get job status: {}", e))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read status response: {}", e))?;

        if !status.is_success() {
            return Err(format!("Get job status failed ({}): {}", status, text));
        }

        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Invalid status response JSON: {}", e))?;

        // SeaTunnel 返回 {"jobStatus": "RUNNING"} 或 {"status": "RUNNING"}
        let job_status = json
            .get("jobStatus")
            .or_else(|| json.get("status"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("No status in response: {}", text))?;

        Ok(job_status)
    }

    /// 停止 Job，POST /api/v1/job/stop
    pub async fn stop_job(&self, job_id: &str) -> Result<(), String> {
        let body = serde_json::json!({ "jobId": job_id });
        let resp = self
            .request(reqwest::Method::POST, "/api/v1/job/stop")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Failed to stop job: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp
                .text()
                .await
                .unwrap_or_else(|_| String::new());
            return Err(format!("Stop job failed ({}): {}", status, text));
        }

        Ok(())
    }

    /// 流式读取日志，GET /api/v1/job/logging/{jobId}，通过 callback 逐行回调
    /// 返回 Ok(()) 表示流结束，Err 表示出错
    pub async fn stream_logs_with_callback<F>(
        &self,
        job_id: &str,
        mut on_line: F,
    ) -> Result<(), String>
    where
        F: FnMut(String),
    {
        let path = format!("/api/v1/job/logging/{}", job_id);
        let resp = self
            .request(reqwest::Method::GET, &path)
            .send()
            .await
            .map_err(|e| format!("Failed to start log stream: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp
                .text()
                .await
                .unwrap_or_else(|_| String::new());
            return Err(format!("Log stream failed ({}): {}", status, text));
        }

        let mut byte_stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = byte_stream.next().await {
            match chunk {
                Err(e) => return Err(format!("Stream error: {}", e)),
                Ok(bytes) => {
                    let text = String::from_utf8(bytes.to_vec())
                        .map_err(|e| format!("Encoding error: {}", e))?;
                    buffer.push_str(&text);
                    // 按换行符分割，输出完整行
                    while let Some(pos) = buffer.find('\n') {
                        let line = buffer[..pos].trim_end_matches('\r').to_string();
                        buffer = buffer[pos + 1..].to_string();
                        on_line(line);
                    }
                }
            }
        }

        // 输出剩余内容（无换行结尾的最后一行）
        if !buffer.is_empty() {
            on_line(buffer);
        }

        Ok(())
    }
}
