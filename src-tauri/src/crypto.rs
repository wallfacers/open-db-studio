use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use aes_gcm::aead::rand_core::RngCore;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use crate::AppResult;

const KEY_ENV: &str = "ODB_MASTER_KEY";

/// 派生或生成主密钥（32 字节）
fn get_key() -> [u8; 32] {
    // 优先从环境变量读取（生产可注入）
    // MVP 阶段使用固定派生密钥（后续迁移到 OS Keychain）
    let raw = std::env::var(KEY_ENV)
        .unwrap_or_else(|_| "open-db-studio-default-key-2026!".to_string());
    let mut key = [0u8; 32];
    let bytes = raw.as_bytes();
    let len = bytes.len().min(32);
    key[..len].copy_from_slice(&bytes[..len]);
    key
}

/// 加密明文密码 → Base64 编码的 nonce(12字节) + ciphertext
pub fn encrypt(plaintext: &str) -> AppResult<String> {
    let raw_key = get_key();
    let key = Key::<Aes256Gcm>::from_slice(&raw_key);
    let cipher = Aes256Gcm::new(key);

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| crate::AppError::Encryption(e.to_string()))?;

    // 格式：base64(nonce) + ":" + base64(ciphertext)
    let encoded = format!(
        "{}:{}",
        BASE64.encode(nonce_bytes),
        BASE64.encode(ciphertext)
    );
    Ok(encoded)
}

/// 解密 Base64 编码的密文 → 明文密码
pub fn decrypt(encoded: &str) -> AppResult<String> {
    let parts: Vec<&str> = encoded.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(crate::AppError::Encryption("Invalid encrypted format".into()));
    }

    let nonce_bytes = BASE64
        .decode(parts[0])
        .map_err(|e| crate::AppError::Encryption(e.to_string()))?;
    let ciphertext = BASE64
        .decode(parts[1])
        .map_err(|e| crate::AppError::Encryption(e.to_string()))?;

    let raw_key = get_key();
    let key = Key::<Aes256Gcm>::from_slice(&raw_key);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|e| crate::AppError::Encryption(e.to_string()))?;

    String::from_utf8(plaintext)
        .map_err(|e| crate::AppError::Encryption(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let password = "my_secret_password_123!";
        let encrypted = encrypt(password).unwrap();
        assert_ne!(encrypted, password);
        let decrypted = decrypt(&encrypted).unwrap();
        assert_eq!(decrypted, password);
    }

    #[test]
    fn test_encrypt_produces_different_ciphertext_each_time() {
        let password = "same_password";
        let enc1 = encrypt(password).unwrap();
        let enc2 = encrypt(password).unwrap();
        // 每次加密 nonce 不同，结果应不同
        assert_ne!(enc1, enc2);
    }

    #[test]
    fn test_decrypt_invalid_input() {
        let result = decrypt("not_valid_base64_format");
        assert!(result.is_err());
    }
}
