cmake_minimum_required(VERSION 3.4.1)

project("node_runner")

# The client flavor must not build or package Node. Gradle supplies this flag
# only for the withServer flavor.
if(EMBEDDED_SERVER)
  add_library(native-lib SHARED src/withServer/cpp/node_runner.cpp)

  target_include_directories(native-lib PRIVATE src/withServer/cpp/include)

  target_link_libraries(native-lib
    log
    ${CMAKE_SOURCE_DIR}/src/withServer/jniLibs/${ANDROID_ABI}/libnode.so
  )
endif()
