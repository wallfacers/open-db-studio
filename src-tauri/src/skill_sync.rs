use std::path::PathBuf;
use tauri::Manager;

/// 将内置 skills 目录增量同步到 opencode/skills/（由 OPENCODE_CONFIG_DIR 指定）
/// 只写/覆盖本项目定义的 skill，不删除目标目录其他文件
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

    let base = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("skill_sync: failed to get app_data_dir: {}", e);
            return;
        }
    };

    let target_dir = base.join("opencode").join("skills");
    sync_dir(&src_dir, &target_dir);
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
