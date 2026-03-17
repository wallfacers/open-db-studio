use std::path::PathBuf;
use tauri::Manager;

/// 将内置 skills 目录同步到 opencode 可读取的目标目录
/// 目标目录优先级：OPENCODE_CONFIG 环境变量的父目录 / skills，其次是 app_config_dir / skills
/// 只写本项目定义的 5 个 skill，不删除目标目录其他文件
pub fn sync_skills_on_startup(app: &tauri::AppHandle) {
    let src_dir = match app.path().resource_dir() {
        Ok(p) => p.join("skills"),
        Err(e) => {
            log::warn!("skill_sync: failed to get resource dir: {}", e);
            return;
        }
    };

    if !src_dir.exists() {
        log::warn!("skill_sync: source skills dir not found: {:?}", src_dir);
        return;
    }

    let target_dir = resolve_target_dir(app);

    sync_dir(&src_dir, &target_dir);
}

fn resolve_target_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(cfg) = std::env::var("OPENCODE_CONFIG") {
        if let Some(parent) = PathBuf::from(&cfg).parent().map(|p| p.to_path_buf()) {
            return parent.join("skills");
        }
    }
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("skills")
}

fn sync_dir(src_dir: &PathBuf, target_dir: &PathBuf) {
    let entries = match std::fs::read_dir(src_dir) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("skill_sync: failed to read src dir {:?}: {}", src_dir, e);
            return;
        }
    };

    for entry in entries.flatten() {
        let skill_dir = entry.path();
        if !skill_dir.is_dir() {
            continue;
        }
        let skill_name = match skill_dir.file_name() {
            Some(n) => n.to_owned(),
            None => continue,
        };
        let src_file = skill_dir.join("SKILL.md");
        if !src_file.exists() {
            continue;
        }
        let dst_dir = target_dir.join(&skill_name);
        let dst_file = dst_dir.join("SKILL.md");

        let needs_copy = if !dst_file.exists() {
            true
        } else {
            sha256_file(&src_file) != sha256_file(&dst_file)
        };

        if needs_copy {
            if let Err(e) = std::fs::create_dir_all(&dst_dir) {
                log::warn!("skill_sync: failed to create dir {:?}: {}", dst_dir, e);
                continue;
            }
            match std::fs::copy(&src_file, &dst_file) {
                Ok(_) => log::info!("skill_sync: synced {:?}", dst_file),
                Err(e) => log::warn!("skill_sync: failed to copy {:?}: {}", dst_file, e),
            }
        }
    }
}

fn sha256_file(path: &PathBuf) -> String {
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    // 简单哈希：使用文件长度 + 前64字节内容做快速比较（避免引入 sha2 依赖）
    let prefix: Vec<u8> = buf.iter().take(64).cloned().collect();
    format!("{}:{}", buf.len(), hex::encode(prefix))
}
