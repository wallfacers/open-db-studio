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

    /// 提交 Job，POST /hazelcast/rest/maps/submit-job，返回 jobId 字符串
    pub async fn submit_job(&self, config_json: &str) -> Result<String, String> {
        let body: serde_json::Value = serde_json::from_str(config_json)
            .map_err(|e| format!("Invalid config JSON: {}", e))?;

        let resp = self
            .request(reqwest::Method::POST, "/hazelcast/rest/maps/submit-job")
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

    /// 查询 Job 状态，GET /hazelcast/rest/maps/running-jobs 或 finished-jobs
    pub async fn get_job_status(&self, job_id: &str) -> Result<String, String> {
        // 先检查运行中的作业
        let running_resp = self
            .request(reqwest::Method::GET, "/hazelcast/rest/maps/running-jobs")
            .send()
            .await
            .map_err(|e| format!("Failed to get running jobs: {}", e))?;

        let running_text = running_resp.text().await.unwrap_or_default();
        if running_text.contains(job_id) {
            return Ok("RUNNING".to_string());
        }

        // 检查已完成的作业
        let finished_resp = self
            .request(reqwest::Method::GET, "/hazelcast/rest/maps/finished-jobs/FINISHED")
            .send()
            .await
            .map_err(|e| format!("Failed to get finished jobs: {}", e))?;

        let finished_text = finished_resp.text().await.unwrap_or_default();
        if finished_text.contains(job_id) {
            return Ok("FINISHED".to_string());
        }

        // 检查失败的作业
        let failed_resp = self
            .request(reqwest::Method::GET, "/hazelcast/rest/maps/finished-jobs/FAILED")
            .send()
            .await
            .map_err(|e| format!("Failed to get failed jobs: {}", e))?;

        let failed_text = failed_resp.text().await.unwrap_or_default();
        if failed_text.contains(job_id) {
            return Ok("FAILED".to_string());
        }

        Ok("UNKNOWN".to_string())
    }

    /// 测试连接（请求当前版本任务列表接口）
    pub async fn test_connection(&self) -> Result<(), String> {
        let resp = self
            .request(reqwest::Method::GET, "/hazelcast/rest/maps/running-jobs")
            .send()
            .await
            .map_err(|e| format!("无法连接到集群: {}", e))?;

        if resp.status().is_success() {
            Ok(())
        } else {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            Err(format!("集群返回错误 ({}): {}", status, text))
        }
    }

    /// 列出所有运行中的作业
    #[allow(dead_code)]
    pub async fn list_running_jobs(&self) -> Result<serde_json::Value, String> {
        let resp = self
            .request(reqwest::Method::GET, "/hazelcast/rest/maps/running-jobs")
            .send()
            .await
            .map_err(|e| format!("Failed to list running jobs: {}", e))?;

        let text = resp.text().await.unwrap_or_default();
        serde_json::from_str(&text).map_err(|e| format!("Invalid JSON: {}", e))
    }

    /// 旧版 get_job_status 保留兼容
    #[allow(dead_code)]
    pub async fn get_job_status_legacy(&self, job_id: &str) -> Result<String, String> {
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

    /// 停止 Job，POST /hazelcast/rest/maps/stop-job
    pub async fn stop_job(&self, job_id: &str) -> Result<(), String> {
        let body = serde_json::json!({ "jobId": job_id });
        let resp = self
            .request(reqwest::Method::POST, "/hazelcast/rest/maps/stop-job")
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

    /// 流式读取日志，GET /hazelcast/rest/maps/job-logs/{jobId}
    /// 注意：SeaTunnel 可能不支持流式日志，此接口待验证
    pub async fn stream_logs_with_callback<F>(
        &self,
        job_id: &str,
        mut on_line: F,
    ) -> Result<(), String>
    where
        F: FnMut(String),
    {
        let path = format!("/hazelcast/rest/maps/job-logs/{}", job_id);
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
