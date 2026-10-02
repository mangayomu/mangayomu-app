/**
 * JNI bridge to start Node.js on Android via node::Start().
 * Includes stdout/stderr → logcat redirection so console.log
 * messages are visible in adb logcat.
 */

#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

#include "node.h"

#define LOG_TAG "NodeRunner"

// ── stdout/stderr → logcat pipes ──────────────────────────────────────────

int stdoutPipe[2];
int stderrPipe[2];
pthread_t stdoutThread;
pthread_t stderrThread;
bool pipesStarted = false;

void* stderrThreadFunc(void*) {
  ssize_t n;
  char buf[2048];
  while ((n = read(stderrPipe[0], buf, sizeof buf - 1)) > 0) {
    if (buf[n - 1] == '\n') --n;
    buf[n] = 0;
    __android_log_write(ANDROID_LOG_ERROR, "nodejs", buf);
  }
  return nullptr;
}

void* stdoutThreadFunc(void*) {
  ssize_t n;
  char buf[2048];
  while ((n = read(stdoutPipe[0], buf, sizeof buf - 1)) > 0) {
    if (buf[n - 1] == '\n') --n;
    buf[n] = 0;
    __android_log_write(ANDROID_LOG_INFO, "nodejs", buf);
  }
  return nullptr;
}

void startPipeRedirect() {
  if (pipesStarted) return;
  pipesStarted = true;

  setvbuf(stdout, nullptr, _IONBF, 0);
  pipe(stdoutPipe);
  dup2(stdoutPipe[1], STDOUT_FILENO);

  setvbuf(stderr, nullptr, _IONBF, 0);
  pipe(stderrPipe);
  dup2(stderrPipe[1], STDERR_FILENO);

  pthread_create(&stdoutThread, nullptr, stdoutThreadFunc, nullptr);
  pthread_detach(stdoutThread);

  pthread_create(&stderrThread, nullptr, stderrThreadFunc, nullptr);
  pthread_detach(stderrThread);
}

// ── JNI entry point ───────────────────────────────────────────────────────

extern "C" JNIEXPORT jint JNICALL
Java_com_mangayomu_app_NodeRunner_nativeStartNode(
    JNIEnv* env,
    jobject /* this */,
    jobjectArray arguments)
{
  // Redirect Node.js stdout/stderr to Android logcat
  startPipeRedirect();

  int argc = env->GetArrayLength(arguments);

  // libuv requires contiguous argument memory.
  size_t argsSize = 0;
  for (int i = 0; i < argc; i++) {
    jstring arg = (jstring)env->GetObjectArrayElement(arguments, i);
    const char* str = env->GetStringUTFChars(arg, nullptr);
    argsSize += strlen(str) + 1;
    env->ReleaseStringUTFChars(arg, str);
    env->DeleteLocalRef(arg);
  }

  char* argsBuffer = (char*)calloc(argsSize, sizeof(char));
  char* argv[argc];
  char* pos = argsBuffer;

  for (int i = 0; i < argc; i++) {
    jstring arg = (jstring)env->GetObjectArrayElement(arguments, i);
    const char* str = env->GetStringUTFChars(arg, nullptr);
    strcpy(pos, str);
    env->ReleaseStringUTFChars(arg, str);
    env->DeleteLocalRef(arg);
    argv[i] = pos;
    pos += strlen(pos) + 1;
  }

  __android_log_print(ANDROID_LOG_INFO, LOG_TAG,
    "Starting Node.js argc=%d argv[0]=%s argv[1]=%s",
    argc, argv[0], argv[1] ? argv[1] : "(null)");

  int exitCode = node::Start(argc, argv);

  free(argsBuffer);
  __android_log_print(ANDROID_LOG_INFO, LOG_TAG,
    "Node.js exited with code %d", exitCode);
  return jint(exitCode);
}
