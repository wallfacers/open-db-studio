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

    /// 轮询 job-info 获取进度日志，返回最终状态字符串（FINISHED / CANCELLED）
    /// SeaTunnel REST API 无流式日志接口，改用每 2s 轮询 /job-info/{jobId}
    pub async fn stream_logs_with_callback<F>(
        &self,
        job_id: &str,
        mut on_line: F,
    ) -> Result<String, String>
    where
        F: FnMut(String),
    {
        let path = format!("/hazelcast/rest/maps/job-info/{}", job_id);
        let mut last_source: u64 = 0;
        let mut last_sink: u64 = 0;

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;

            let resp = self
                .request(reqwest::Method::GET, &path)
                .send()
                .await
                .map_err(|e| format!("Failed to fetch job info: {}", e))?;

            if !resp.status().is_success() {
                return Err(format!("job-info request failed: {}", resp.status()));
            }

            let info: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse job info: {}", e))?;

            let status = info["jobStatus"].as_str().unwrap_or("UNKNOWN").to_string();

            // 提取进度指标
            let source_count = info["metrics"]["SourceReceivedCount"]
                .as_u64()
                .unwrap_or(0);
            let sink_count = info["metrics"]["SinkWriteCount"].as_u64().unwrap_or(0);

            if source_count != last_source || sink_count != last_sink {
                on_line(format!(
                    "[INFO] {} | 已读取: {} 行 | 已写入: {} 行",
                    status, source_count, sink_count
                ));
                last_source = source_count;
                last_sink = sink_count;
            }

            match status.as_str() {
                "FINISHED" => {
                    on_line(format!(
                        "[INFO] 任务完成，共迁移 {} 行",
                        sink_count
                    ));
                    return Ok("FINISHED".to_string());
                }
                "CANCELLED" => {
                    on_line("[INFO] 任务已取消".to_string());
                    return Ok("CANCELLED".to_string());
                }
                "FAILED" => {
                    let error = info["errorMsg"].as_str().unwrap_or("Unknown error");
                    // 只取第一行（后面是 Java stacktrace）
                    let first_line = error.lines().next().unwrap_or(error);
                    on_line(format!("[ERROR] 任务失败: {}", first_line));
                    return Ok("FAILED".to_string());
                }
                _ => {
                    // RUNNING 或其他，继续轮询
                }
            }
        }
    }
}
